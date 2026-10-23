/**
 * Chunked WP plugin import (issue #475): a large site is imported as a
 * loop of bounded requests instead of one giant Worker invocation. These
 * tests cover the state that must survive chunk boundaries:
 *
 * - translation groups: a translation in chunk N links to its sibling
 *   imported in chunk N-1 via the seeded translationGroup map
 * - taxonomy lookup maps: later chunks reload the plan from the DB
 *   instead of re-running term creation
 * - comment threading: a reply in comment page N threads onto its parent
 *   from page N-1 via the seeded rootIds map
 */

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { handleTaxonomyCreate } from "../../../src/api/handlers/taxonomies.js";
import {
	importContent as importContentFromPlugin,
	type WpPluginImportConfig,
} from "../../../src/astro/routes/api/import/wordpress-plugin/execute.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { importCommentsFromPlugin, type PluginComment } from "../../../src/import/comments.js";
import type { NormalizedItem } from "../../../src/import/types.js";
import { loadTaxonomyPlanFromDb } from "../../../src/import/wxr-taxonomies.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const importContent: typeof importContentFromPlugin = (...args) => {
	args[7] ??= "https://source.example";
	return importContentFromPlugin(...args);
};

function makeItem(overrides: Partial<NormalizedItem>): NormalizedItem {
	return {
		sourceId: 1,
		postType: "post",
		status: "publish",
		slug: "item",
		title: "Item",
		content: [],
		date: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

function makeConfig(): WpPluginImportConfig {
	return {
		postTypeMappings: { post: { collection: "post", enabled: true } },
		skipExisting: true,
	};
}

function makeEmdash(db: Kysely<Database>): EmDashHandlers {
	// ponytail: minimal stub — importContent only touches db + handleContentCreate
	return {
		db,
		handleContentCreate: (collection: string, body: { data: Record<string, unknown> }) =>
			handleContentCreate(db, collection, body),
	} as unknown as EmDashHandlers;
}

const manifest = { collections: { post: {} } } as unknown as EmDashManifest;

describe("chunked WP plugin import — cross-chunk state", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("does not inherit a different guest author from a skipped slug collision", async () => {
		const emdash = makeEmdash(db);
		await importContent(
			[makeItem({ slug: "welcome", author: "bob" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
		);
		const original = await db
			.selectFrom("ec_post")
			.select(["primary_byline_id"])
			.where("slug", "=", "welcome")
			.executeTakeFirstOrThrow();
		const result = await importContent(
			[
				makeItem({ slug: "welcome", author: "alice" }),
				makeItem({ sourceId: 2, slug: "alice-new", author: "alice" }),
			],
			makeConfig(),
			emdash,
			manifest,
			undefined,
		);
		expect(result.result.skipped).toBe(1);
		expect(result.result.imported).toBe(1);
		const created = await db
			.selectFrom("ec_post")
			.select(["primary_byline_id"])
			.where("slug", "=", "alice-new")
			.executeTakeFirstOrThrow();
		expect(created.primary_byline_id).not.toBe(original.primary_byline_id);
	});

	it.each(["different source", "missing provenance"])(
		"does not borrow a skipped byline with %s",
		async (mode) => {
			const emdash = makeEmdash(db);
			await importContent(
				[makeItem({ slug: "welcome", author: "alice" })],
				makeConfig(),
				emdash,
				manifest,
				undefined,
			);
			const original = await db
				.selectFrom("ec_post")
				.select("primary_byline_id")
				.where("slug", "=", "welcome")
				.executeTakeFirstOrThrow();
			if (mode === "missing provenance") {
				await db
					.deleteFrom("options")
					.where("name", "=", `wordpress_import_byline:${original.primary_byline_id}`)
					.execute();
			}
			await importContent(
				[
					makeItem({ slug: "welcome", author: "alice" }),
					makeItem({ sourceId: 2, slug: "alice-new", author: "alice" }),
				],
				makeConfig(),
				emdash,
				manifest,
				undefined,
				undefined,
				undefined,
				mode === "different source" ? "https://other.example" : "https://source.example",
			);
			const created = await db
				.selectFrom("ec_post")
				.select("primary_byline_id")
				.where("slug", "=", "alice-new")
				.executeTakeFirstOrThrow();
			expect(created.primary_byline_id).not.toBe(original.primary_byline_id);
		},
	);

	it("reuses guest bylines across serialized content chunks without merging colliding slugs", async () => {
		let bylines = new Map<string, string>();
		const emdash = makeEmdash(db);
		for (const offset of [0, 50]) {
			const items = Array.from({ length: offset === 0 ? 50 : 11 }, (_, i) => {
				const id = offset + i + 1;
				return makeItem({
					sourceId: id,
					slug: `post-${id}`,
					author: id % 2 ? "author.one" : "authorone",
				});
			});
			const result = await importContent(
				items,
				makeConfig(),
				emdash,
				manifest,
				undefined,
				undefined,
				bylines,
			);
			expect(result.result.imported).toBe(items.length);
			bylines = new Map(Object.entries(JSON.parse(JSON.stringify(Object.fromEntries(bylines)))));
		}
		const rows = await db.selectFrom("_emdash_bylines").selectAll().execute();
		expect(rows).toHaveLength(2);
		expect(bylines.size).toBe(2);
		const posts = await db.selectFrom("ec_post").select(["slug", "primary_byline_id"]).execute();
		for (const parity of [0, 1]) {
			const ids = new Set(
				posts
					.filter((post) => Number(post.slug.split("-")[1]) % 2 === parity)
					.map((post) => post.primary_byline_id),
			);
			expect(ids.size).toBe(1);
			expect(ids.has(null)).toBe(false);
		}
	});

	it("recovers guest bylines when a partial plugin import restarts without its cache", async () => {
		const items = Array.from({ length: 65 }, (_, i) =>
			makeItem({
				sourceId: i + 1,
				slug: `post-${i + 1}`,
				author: i % 2 ? "author.one" : "authorone",
			}),
		);
		const emdash = makeEmdash(db);
		const originalBylines = new Map<string, string>();
		const first = await importContent(
			items.slice(0, 50),
			makeConfig(),
			emdash,
			manifest,
			undefined,
			undefined,
			originalBylines,
		);
		expect(first.result.imported).toBe(50);
		const recovered = new Map<string, string>();
		const replay = await importContent(
			items.slice(0, 50),
			makeConfig(),
			emdash,
			manifest,
			undefined,
			undefined,
			recovered,
		);
		expect(replay.result.skipped).toBe(50);
		const resumed = await importContent(
			items.slice(50),
			makeConfig(),
			emdash,
			manifest,
			undefined,
			undefined,
			new Map(Object.entries(JSON.parse(JSON.stringify(Object.fromEntries(recovered))))),
		);
		expect(resumed.result.imported).toBe(15);
		expect(await db.selectFrom("_emdash_bylines").select("id").execute()).toHaveLength(2);
		const posts = await db.selectFrom("ec_post").select(["slug", "primary_byline_id"]).execute();
		expect(posts).toHaveLength(65);
		for (const post of posts) {
			const login = Number(post.slug.split("-")[1]) % 2 ? "authorone" : "author.one";
			expect(post.primary_byline_id).toBe(originalBylines.get(`${login}:`));
		}
	});

	it.each([
		[null, "first"],
		["first", null],
		["first", "second"],
	] as const)(
		"respects changed author mappings from %s to %s on restart",
		async (before, after) => {
			const users = new UserRepository(db);
			const firstUser = await users.create({
				email: "first@example.com",
				name: "First",
				role: "author",
			});
			const secondUser = await users.create({
				email: "second@example.com",
				name: "Second",
				role: "author",
			});
			const userIds = { first: firstUser.id, second: secondUser.id };
			const oldUserId = before ? userIds[before] : null;
			const newUserId = after ? userIds[after] : null;
			const items = [
				makeItem({ sourceId: 1, slug: "old-post", author: "author" }),
				makeItem({ sourceId: 2, slug: "new-post", author: "author" }),
			];
			const emdash = makeEmdash(db);
			const oldCache = new Map<string, string>();
			await importContent(
				items.slice(0, 1),
				{
					...makeConfig(),
					authorMappings: { author: oldUserId },
				},
				emdash,
				manifest,
				undefined,
				undefined,
				oldCache,
			);
			const originalBylineId = oldCache.get(`author:${oldUserId ?? ""}`);
			const result = await importContent(
				items,
				{
					...makeConfig(),
					authorMappings: { author: newUserId },
				},
				emdash,
				manifest,
			);
			expect(result.result.imported).toBe(1);
			expect(result.result.skipped).toBe(1);
			const posts = await db.selectFrom("ec_post").select(["slug", "primary_byline_id"]).execute();
			expect(posts.find((post) => post.slug === "old-post")?.primary_byline_id).toBe(
				originalBylineId,
			);
			const newBylineId = posts.find((post) => post.slug === "new-post")!.primary_byline_id;
			expect(newBylineId).not.toBe(originalBylineId);
			const byline = await db
				.selectFrom("_emdash_bylines")
				.select("user_id")
				.where("id", "=", newBylineId!)
				.executeTakeFirstOrThrow();
			expect(byline.user_id).toBe(newUserId);
		},
	);

	it("links translations across chunks via the seeded translationGroup map", async () => {
		const emdash = makeEmdash(db);
		const translationGroups = new Map<string, string>();

		// Chunk 1: the default-locale item establishes the group mapping.
		const first = await importContent(
			[makeItem({ sourceId: 1, slug: "hello", locale: "en", translationGroup: "g1" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
			translationGroups,
		);
		expect(first.result.imported).toBe(1);
		expect(translationGroups.get("g1")).toBeDefined();

		// Chunk 2 (separate importContent call = separate invocation): the
		// translation must link into the same group.
		const second = await importContent(
			[makeItem({ sourceId: 2, slug: "hallo", locale: "de", translationGroup: "g1" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
			translationGroups,
		);
		expect(second.result.imported).toBe(1);

		const rows = await db
			// eslint-disable-next-line typescript/no-explicit-any -- dynamic ec_ table not in the static schema
			.selectFrom("ec_post" as any)
			.select(["slug", "translation_group"])
			.where("slug", "in", ["hello", "hallo"])
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.translation_group).toBeTruthy();
		expect(rows[0]!.translation_group).toBe(rows[1]!.translation_group);
	});

	it("rebuilds the id maps from existing content on a resumed run", async () => {
		const emdash = makeEmdash(db);
		const item = makeItem({ sourceId: 7, slug: "resumed" });

		const first = await importContent([item], makeConfig(), emdash, manifest, undefined);
		expect(first.result.imported).toBe(1);
		const originalId = first.contentIdMap.get(7);
		expect(originalId).toBeDefined();

		// Re-run (e.g. after the tab was closed): skipExisting skips the
		// insert but must still yield the mapping comments/menus need.
		const second = await importContent([item], makeConfig(), emdash, manifest, undefined);
		expect(second.result.imported).toBe(0);
		expect(second.result.skipped).toBe(1);
		expect(second.contentIdMap.get(7)).toBe(originalId);
		expect(second.collectionByWpId.get(7)).toBe("post");
	});

	it("counts only existing content as skipped, not post types left out of the import", async () => {
		const emdash = makeEmdash(db);
		const items = [
			makeItem({ sourceId: 1, slug: "kept" }),
			makeItem({ sourceId: 2, slug: "about", postType: "page" }),
		];

		const first = await importContent(items, makeConfig(), emdash, manifest, undefined);
		expect(first.result).toMatchObject({ imported: 1, skipped: 0 });

		const second = await importContent(items, makeConfig(), emdash, manifest, undefined);
		expect(second.result).toMatchObject({ imported: 0, skipped: 1 });
	});

	it("loadTaxonomyPlanFromDb rebuilds lookup maps without creating anything", async () => {
		await handleTaxonomyCreate(db, {
			name: "company",
			label: "Companies",
			hierarchical: false,
			collections: ["post"],
		});
		const repo = new TaxonomyRepository(db);
		const term = await repo.create({ name: "company", slug: "acme", label: "ACME" });

		const plan = await loadTaxonomyPlanFromDb(db);

		expect(plan.termIdByNameAndSlug.get("company")?.get("acme")).toBe(term.id);
		expect([...(plan.collectionsByTaxonomy.get("company") ?? [])]).toEqual(["post"]);
		// Nothing was created by the loader
		expect(plan.termsCreated).toEqual({});
		expect(plan.missingTaxonomies).toEqual([]);
	});

	it("threads a reply onto a parent imported in an earlier comment chunk", async () => {
		const emdash = makeEmdash(db);
		const { contentIdMap, collectionByWpId } = await importContent(
			[makeItem({ sourceId: 10, slug: "commented" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
		);

		const parent: PluginComment = {
			id: 100,
			post_id: 10,
			parent_id: null,
			author_name: "Alice",
			author_email: "alice@example.com",
			body: "First!",
			date_gmt: "2026-01-02T10:00:00Z",
			status: "approved",
		};
		const reply: PluginComment = {
			id: 200,
			post_id: 10,
			parent_id: 100,
			author_name: "Bob",
			author_email: "bob@example.com",
			body: "Replying to Alice",
			date_gmt: "2026-01-03T10:00:00Z",
			status: "approved",
		};

		// Page 1 and page 2 as separate invocations sharing the rootIds map.
		const rootIds = new Map<number, string>();
		const page1 = await importCommentsFromPlugin(
			[parent],
			db,
			contentIdMap,
			collectionByWpId,
			rootIds,
		);
		expect(page1.imported).toBe(1);

		const page2 = await importCommentsFromPlugin(
			[reply],
			db,
			contentIdMap,
			collectionByWpId,
			rootIds,
		);
		expect(page2.imported).toBe(1);

		const rows = await db
			.selectFrom("_emdash_comments")
			.select(["author_name", "parent_id", "id"])
			.orderBy("created_at", "asc")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[1]!.parent_id).toBe(rows[0]!.id);
	});
});
