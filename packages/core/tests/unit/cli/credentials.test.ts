import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getCredentials,
	listCredentialKeys,
	removeCredentials,
	saveCredentials,
} from "../../../src/cli/credentials.js";

const credential = {
	accessToken: "test-access",
	refreshToken: "test-refresh",
	expiresAt: "2099-01-01T00:00:00Z",
};
const source = new URL("../../../src/cli/credentials.ts", import.meta.url).href;
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "emdash-cli-credentials-"));
	vi.stubEnv("XDG_CONFIG_HOME", directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function runConcurrent(actions: string[]) {
	const children = actions.map((action) => {
		const script = `
			import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			const originalRead = fs.readFileSync;
			fs.readFileSync = function(path, ...args) {
				const value = originalRead.call(this, path, ...args);
				if (String(path).endsWith("auth.json")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
				return value;
			};
			syncBuiltinESMExports();
			const { saveCredentials, removeCredentials } = await import(${JSON.stringify(source)});
			process.once("message", () => {
				try { ${action}; process.disconnect(); }
				catch(error) { console.error(error); process.exit(1); }
			});
			process.send("ready");
		`;
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", script],
			{
				env: { ...process.env, XDG_CONFIG_HOME: directory },
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			},
		);
		let stderr = "";
		child.stderr!.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const ready = new Promise<void>((resolve, reject) => {
			child.once("message", () => resolve());
			child.once("error", reject);
			child.once("exit", (code) => {
				if (code !== 0) reject(new Error(stderr));
			});
		});
		const exited = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => {
				if (code !== 0) {
					reject(new Error(stderr));
					return;
				}
				resolve();
			});
		});
		return { child, ready, exited };
	});
	const startChildren = async () => {
		await Promise.all(children.map(({ ready }) => ready));
		for (const { child } of children) child.send("start");
	};
	try {
		await Promise.all([startChildren(), Promise.all(children.map(({ exited }) => exited))]);
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
	}
}

describe("CLI credential storage", () => {
	it("preserves every site's credentials when separate CLI processes save concurrently", async () => {
		saveCredentials("https://existing.example", credential);
		await runConcurrent(
			Array.from(
				{ length: 8 },
				(_, n) => `saveCredentials("https://site-${n}.example", ${JSON.stringify(credential)})`,
			),
		);
		expect(listCredentialKeys()).toHaveLength(9);
		for (let n = 0; n < 8; n++)
			expect(getCredentials(`https://site-${n}.example`)).toEqual(credential);
		expect(getCredentials("https://existing.example")).toEqual(credential);
	}, 20_000);

	it("does not resurrect a signed-out site while other processes save", async () => {
		saveCredentials("https://removed.example", credential);
		await runConcurrent([
			'removeCredentials("https://removed.example")',
			...Array.from(
				{ length: 7 },
				(_, n) => `saveCredentials("https://site-${n}.example", ${JSON.stringify(credential)})`,
			),
		]);
		expect(getCredentials("https://removed.example")).toBeNull();
		expect(listCredentialKeys()).toHaveLength(7);
	}, 20_000);

	it("keeps the existing store format and owner-only permissions", () => {
		saveCredentials("https://site.example", credential);
		const path = join(directory, "emdash", "auth.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "https://site.example": credential });
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(removeCredentials("https://site.example")).toBe(true);
		expect(removeCredentials("https://site.example")).toBe(false);
	});
});
