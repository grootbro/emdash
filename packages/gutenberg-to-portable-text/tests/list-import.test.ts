import { describe, expect, it } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextTextBlock } from "../src/types.js";

function convert(html: string, attrs: Record<string, unknown> = {}): PortableTextTextBlock[] {
	return gutenbergToPortableText(
		`<!-- wp:list ${JSON.stringify(attrs)} -->${html}<!-- /wp:list -->`,
	) as PortableTextTextBlock[];
}

function outline(blocks: PortableTextTextBlock[]) {
	return blocks.map((block) => [
		block.children.map((span) => span.text).join(""),
		block.listItem,
		block.level,
	]);
}

describe("WordPress list import", () => {
	it("visits mixed descendants once at their actual level", () => {
		const blocks = convert(
			'<ul><li>A<ol start="3"><li>B<ul><li>C</li></ul></li><li>D</li></ol></li><li>E</li></ul>',
		);
		expect(outline(blocks)).toEqual([
			["A", "bullet", 1],
			["B", "number", 2],
			["C", "bullet", 3],
			["D", "number", 2],
			["E", "bullet", 1],
		]);
	});

	it("preserves opposite-type sibling lists in source order", () => {
		const blocks = convert(
			'<ul><li>A<ol start="8"><li>B</li></ol><ul><li>C</li></ul><ol start="3"><li>D</li></ol></li></ul>',
		);
		expect(outline(blocks)).toEqual([
			["A", "bullet", 1],
			["B", "number", 2],
			["C", "bullet", 2],
			["D", "number", 2],
		]);
		expect(blocks[1]).toMatchObject({ listStart: 8 });
		expect(blocks[3]).toMatchObject({ listStart: 3 });
		expect(blocks[1]).toHaveProperty("listId");
		expect(blocks[1]!.listId).not.toBe(blocks[3]!.listId);
	});

	it("preserves root and nested ordered starts from HTML", () => {
		const blocks = convert(
			'<ol start="4"><li>A<ul><li>B<ol start="8"><li>C</li></ol></li></ul></li><li>D</li></ol>',
			{ ordered: true },
		);
		expect(outline(blocks)).toEqual([
			["A", "number", 1],
			["B", "bullet", 2],
			["C", "number", 3],
			["D", "number", 1],
		]);
		expect(blocks[0]).toMatchObject({ listStart: 4 });
		expect(blocks[2]).toMatchObject({ listStart: 8 });
		expect(blocks[3]).toMatchObject({ listStart: 4, listId: blocks[0]!.listId });
	});

	it("carries starts and list identities through WordPress 6 list-item blocks", () => {
		const content = `<!-- wp:list {"ordered":true,"start":4} --><ol start="4">
<!-- wp:list-item --><li>A<!-- wp:list {"ordered":true,"start":8} --><ol start="8">
<!-- wp:list-item --><li>B</li><!-- /wp:list-item -->
</ol><!-- /wp:list --></li><!-- /wp:list-item -->
<!-- wp:list-item --><li>C</li><!-- /wp:list-item -->
</ol><!-- /wp:list -->`;
		const blocks = gutenbergToPortableText(content) as PortableTextTextBlock[];
		expect(outline(blocks)).toEqual([
			["A", "number", 1],
			["B", "number", 2],
			["C", "number", 1],
		]);
		expect(blocks[0]).toMatchObject({ listStart: 4 });
		expect(blocks[1]).toMatchObject({ listStart: 8 });
		expect(blocks[2]).toMatchObject({ listStart: 4, listId: blocks[0]!.listId });
		expect(blocks[0]!.listId).not.toBe(blocks[1]!.listId);
	});

	it("uses the Gutenberg start attribute when HTML omits it", () => {
		const blocks = convert("<ol><li>A</li><li>B</li></ol>", { ordered: true, start: 9 });
		expect(blocks).toHaveLength(2);
		for (const block of blocks)
			expect(block).toMatchObject({ listStart: 9, listId: expect.any(String) });
	});

	it("keeps adjacent ordered lists as separate numbering sequences", () => {
		const content = [4, 8, 1]
			.map(
				(start) =>
					`<!-- wp:list {"ordered":true,"start":${start}} --><ol start="${start}"><li>Item ${start}</li></ol><!-- /wp:list -->`,
			)
			.join("");
		const blocks = gutenbergToPortableText(content) as PortableTextTextBlock[];
		expect(blocks.map((block) => block.listStart)).toEqual([4, 8, 1]);
		expect(new Set(blocks.map((block) => block.listId)).size).toBe(3);
	});

	it.each(["0", "-1", "1.5", "invalid", "2147483648"])(
		"uses supported numbering for invalid start %s",
		(start) => {
			const [block] = convert(`<ol start="${start}"><li>A</li></ol>`, { ordered: true });
			expect(block).toMatchObject({ listStart: 1 });
		},
	);
});
