import { i18n } from "@lingui/core";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm, SetupStep } from "../../../auth-atproto/src/admin.js";
import { render } from "../utils/render.js";

beforeEach(() => {
	i18n.loadAndActivate({
		locale: "ru",
		messages: {
			"/gyI39": "Адрес Atmosphere",
			"5lWFkC": "Войти",
			J28zul: "Подключение…",
			"9M2CU4": "Не удалось начать вход",
			jS2X6L: "Войдите с адресом Bluesky/Atmosphere",
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe.each(["login", "setup"] as const)("Atmosphere %s localization", (kind) => {
	it("translates the label, submit states, and fallback error", async () => {
		let respond!: (response: Response) => void;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					respond = resolve;
				}),
		);
		const screen = await render(
			kind === "login" ? <LoginForm /> : <SetupStep onComplete={() => {}} />,
		);
		await screen.getByRole("textbox", { name: "Адрес Atmosphere" }).fill("test.bsky.social");
		if (kind === "setup")
			await expect.element(screen.getByText("Войдите с адресом Bluesky/Atmosphere")).toBeVisible();
		await screen.getByRole("button", { name: "Войти" }).click();
		await expect.element(screen.getByRole("button", { name: "Подключение…" })).toBeDisabled();
		respond(Response.json({}, { status: 500 }));
		await expect.element(screen.getByText("Не удалось начать вход")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Войти" })).toBeEnabled();
	});

	it("updates the form when the admin language changes", async () => {
		const screen = await render(
			kind === "login" ? <LoginForm /> : <SetupStep onComplete={() => {}} />,
		);
		await expect.element(screen.getByRole("textbox", { name: "Адрес Atmosphere" })).toBeVisible();
		i18n.loadAndActivate({
			locale: "ar",
			messages: { "/gyI39": "معرّف أتموسفير", "5lWFkC": "تسجيل الدخول" },
		});
		await expect.element(screen.getByRole("textbox", { name: "معرّف أتموسفير" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "تسجيل الدخول" })).toBeVisible();
	});
});
