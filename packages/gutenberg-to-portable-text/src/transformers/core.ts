/**
 * Transformers for WordPress core/* blocks
 */

import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

import {
	decodeUrlEntities,
	extractAlt,
	extractCaption,
	extractSrc,
	extractText,
} from "../inline.js";
import type {
	GutenbergBlock,
	PortableTextBlock,
	PortableTextButtonBlock,
	PortableTextTextBlock,
	BlockTransformer,
	TransformContext,
} from "../types.js";
import { attrString, attrNumber, attrBoolean, attrObject } from "../types.js";
import { sanitizeHref } from "../url.js";

// Regex patterns for core block transformers
const LI_TAG_PATTERN = /<li[^>]*>([\s\S]*?)<\/li>/i;
const P_TAG_PATTERN = /<p[^>]*>([\s\S]*?)<\/p>/gi;
const P_TAG_SINGLE_PATTERN = /<p[^>]*>([\s\S]*?)<\/p>/i;
const HREF_PATTERN = /href="([^"]*)"/i;
const ANCHOR_HREF_PATTERN = /<a\b[^>]*?\shref="([^"]*)"/i;
const DATA_ID_PATTERN = /data-id=["'](\d+)["']/i;
const CODE_TAG_PATTERN_SINGLE = /<code[^>]*>([\s\S]*?)<\/code>/i;
const IMG_TAG_GLOBAL = /<img[^>]+>/gi;
const CITE_TAG_PATTERN = /<cite[^>]*>([\s\S]*?)<\/cite>/i;
const LT_ENTITY_PATTERN = /&lt;/g;
const GT_ENTITY_PATTERN = /&gt;/g;
const AMP_ENTITY_PATTERN = /&amp;/g;
const QUOT_ENTITY_PATTERN = /&quot;/g;
const APOS_ENTITY_PATTERN = /&#039;/g;
const NBSP_ENTITY_PATTERN = /&nbsp;/g;
const LIST_START_PATTERN = /^\+?\d+$/;

/**
 * core/paragraph → block with style "normal"
 */
export const paragraph: BlockTransformer = (block, _options, context) => {
	const { children, markDefs } = context.parseInlineContent(block.innerHTML);

	// Skip empty paragraphs
	if (children.length === 1 && children[0]?.text === "") {
		return [];
	}

	const result: PortableTextTextBlock = {
		_type: "block",
		_key: context.generateKey(),
		style: "normal",
		children,
	};

	if (markDefs.length > 0) {
		result.markDefs = markDefs;
	}

	return [result];
};

/**
 * core/heading → block with style "h1"-"h6"
 */
export const heading: BlockTransformer = (block, _options, context) => {
	const level = attrNumber(block.attrs, "level") ?? 2;
	const { children, markDefs } = context.parseInlineContent(block.innerHTML);

	const result: PortableTextTextBlock = {
		_type: "block",
		_key: context.generateKey(),
		style: toHeadingStyle(level),
		children,
	};

	if (markDefs.length > 0) {
		result.markDefs = markDefs;
	}

	return [result];
};

/**
 * core/list → blocks with listItem
 *
 * Handles both old format (HTML list) and new format (innerBlocks with list-item)
 */
export const list: BlockTransformer = (block, _options, context) =>
	convertListBlock(block, 1, context);

type ListElement = DefaultTreeAdapterMap["element"] & { tagName: "ul" | "ol" };
type ListChild = DefaultTreeAdapterMap["childNode"];
type ListMetadata = Pick<PortableTextTextBlock, "listId" | "listStart">;

function isListElement(node: ListChild): node is ListElement {
	return "tagName" in node && (node.tagName === "ul" || node.tagName === "ol");
}

function normalizeListStart(value: unknown): number | undefined {
	const number =
		typeof value === "string" && LIST_START_PATTERN.test(value.trim()) ? Number(value) : value;
	return typeof number === "number" &&
		Number.isInteger(number) &&
		number >= 1 &&
		number <= 2_147_483_647
		? number
		: undefined;
}

function listMetadata(
	ordered: boolean,
	element: ListElement | undefined,
	context: TransformContext,
	start?: unknown,
): ListMetadata {
	if (!ordered) return {};
	return {
		listId: context.generateKey(),
		listStart:
			normalizeListStart(start) ??
			normalizeListStart(element?.attrs.find((attr) => attr.name === "start")?.value) ??
			1,
	};
}

function convertListBlock(
	block: GutenbergBlock,
	level: number,
	context: TransformContext,
): PortableTextTextBlock[] {
	const fragment = parseFragment(block.innerHTML);
	const element = fragment.childNodes.find(isListElement);
	const ordered =
		typeof block.attrs.ordered === "boolean" ? block.attrs.ordered : element?.tagName === "ol";
	const listItem = ordered ? "number" : "bullet";
	const metadata = listMetadata(ordered, element, context, block.attrs.start);
	if (block.innerBlocks.length > 0) {
		return parseListItemBlocks(block.innerBlocks, listItem, level, context, metadata);
	}
	return parseListItems(
		element?.childNodes ?? fragment.childNodes,
		listItem,
		level,
		context,
		metadata,
	);
}

function parseListItemBlocks(
	innerBlocks: GutenbergBlock[],
	listItem: "bullet" | "number",
	level: number,
	context: TransformContext,
	metadata: ListMetadata,
): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];
	for (const itemBlock of innerBlocks) {
		if (itemBlock.blockName !== "core/list-item") continue;
		const textContent = itemBlock.innerHTML.match(LI_TAG_PATTERN)?.[1]?.trim() || "";
		if (textContent) {
			blocks.push(listTextBlock(textContent, listItem, level, context, metadata));
		}
		for (const nested of itemBlock.innerBlocks) {
			if (nested.blockName === "core/list") {
				blocks.push(...convertListBlock(nested, level + 1, context));
			}
		}
	}
	return blocks;
}

function listTextBlock(
	html: string,
	listItem: "bullet" | "number",
	level: number,
	context: TransformContext,
	metadata: ListMetadata,
): PortableTextTextBlock {
	const { children, markDefs } = context.parseInlineContent(html);
	return {
		_type: "block",
		_key: context.generateKey(),
		style: "normal",
		listItem,
		level,
		...metadata,
		children,
		...(markDefs.length > 0 ? { markDefs } : {}),
	};
}

function withoutNestedLists(node: ListChild, lists: ListElement[]): ListChild[] {
	if (isListElement(node)) {
		lists.push(node);
		return [];
	}
	if ("childNodes" in node) {
		return [
			{ ...node, childNodes: node.childNodes.flatMap((child) => withoutNestedLists(child, lists)) },
		];
	}
	return [node];
}

function parseListItems(
	nodes: ListChild[],
	listItem: "bullet" | "number",
	level: number,
	context: TransformContext,
	metadata: ListMetadata,
): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];
	for (const item of nodes) {
		if (!("tagName" in item) || item.tagName !== "li") continue;
		const nestedLists: ListElement[] = [];
		const inlineItem = {
			...item,
			childNodes: item.childNodes.flatMap((child) => withoutNestedLists(child, nestedLists)),
		};
		const html = serialize(inlineItem).trim();
		if (html) blocks.push(listTextBlock(html, listItem, level, context, metadata));
		for (const nested of nestedLists) {
			const ordered = nested.tagName === "ol";
			blocks.push(
				...parseListItems(
					nested.childNodes,
					ordered ? "number" : "bullet",
					level + 1,
					context,
					listMetadata(ordered, nested, context),
				),
			);
		}
	}
	return blocks;
}

/**
 * core/quote → block with style "blockquote"
 */
export const quote: BlockTransformer = (block, _options, context) => {
	const blocks: PortableTextBlock[] = [];

	// Extract paragraphs from the blockquote
	let match;

	while ((match = P_TAG_PATTERN.exec(block.innerHTML)) !== null) {
		const content = match[1] || "";
		const { children, markDefs } = context.parseInlineContent(content);

		const quoteBlock: PortableTextTextBlock = {
			_type: "block",
			_key: context.generateKey(),
			style: "blockquote",
			children,
		};

		if (markDefs.length > 0) {
			quoteBlock.markDefs = markDefs;
		}

		blocks.push(quoteBlock);
	}

	// If no paragraphs found, treat entire content as quote
	if (blocks.length === 0) {
		const { children, markDefs } = context.parseInlineContent(block.innerHTML);

		const quoteBlock: PortableTextTextBlock = {
			_type: "block",
			_key: context.generateKey(),
			style: "blockquote",
			children,
		};

		if (markDefs.length > 0) {
			quoteBlock.markDefs = markDefs;
		}

		blocks.push(quoteBlock);
	}

	// Handle citation if present
	const citation = attrString(block.attrs, "citation");
	if (citation) {
		const { children, markDefs } = context.parseInlineContent(citation);

		const citationBlock: PortableTextTextBlock = {
			_type: "block",
			_key: context.generateKey(),
			style: "normal",
			children: [
				{
					_type: "span",
					_key: context.generateKey(),
					text: "— ",
				},
				...children,
			],
		};

		if (markDefs.length > 0) {
			citationBlock.markDefs = markDefs;
		}

		blocks.push(citationBlock);
	}

	return blocks;
};

/**
 * core/image → image block
 */
export const image: BlockTransformer = (block, options, context) => {
	const wpId = attrNumber(block.attrs, "id");
	const src = attrString(block.attrs, "url") ?? extractSrc(block.innerHTML);
	const alt = attrString(block.attrs, "alt") ?? extractAlt(block.innerHTML);
	const caption = extractCaption(block.innerHTML);
	const align = attrString(block.attrs, "align");

	// Resolve media ID if we have a map
	const ref = wpId && options.mediaMap?.get(wpId);

	return [
		{
			_type: "image",
			_key: context.generateKey(),
			asset: {
				_type: "reference",
				_ref: ref || String(wpId || src || ""),
				url: src,
			},
			alt,
			caption,
			alignment: mapAlignment(align),
		},
	];
};

/**
 * core/code → code block
 */
export const code: BlockTransformer = (block, _options, context) => {
	// Extract code from <pre><code>...</code></pre>
	const codeMatch = block.innerHTML.match(CODE_TAG_PATTERN_SINGLE);
	const codeContent = codeMatch?.[1] || block.innerHTML;

	// Decode HTML entities
	const decoded = decodeHtmlEntities(codeContent);

	return [
		{
			_type: "code",
			_key: context.generateKey(),
			code: decoded,
			language: attrString(block.attrs, "language"),
		},
	];
};

/**
 * core/preformatted → code block (no syntax highlighting)
 */
export const preformatted: BlockTransformer = (block, _options, context) => {
	const text = extractText(block.innerHTML);

	return [
		{
			_type: "code",
			_key: context.generateKey(),
			code: text,
		},
	];
};

/**
 * core/separator / core/spacer → break block
 */
export const separator: BlockTransformer = (_block, _options, context) => {
	return [
		{
			_type: "break",
			_key: context.generateKey(),
			style: "lineBreak",
		},
	];
};

/**
 * core/gallery → gallery block
 */
export const gallery: BlockTransformer = (block, options, context) => {
	const images: Array<{
		_type: "image";
		_key: string;
		asset: { _type: "reference"; _ref: string; url?: string };
		alt?: string;
		caption?: string;
	}> = [];

	// Extract images from inner blocks or HTML
	if (block.innerBlocks.length > 0) {
		for (const innerBlock of block.innerBlocks) {
			if (innerBlock.blockName === "core/image") {
				const wpId = attrNumber(innerBlock.attrs, "id");
				const src = attrString(innerBlock.attrs, "url") ?? extractSrc(innerBlock.innerHTML);
				const alt = attrString(innerBlock.attrs, "alt") ?? extractAlt(innerBlock.innerHTML);
				const caption = extractCaption(innerBlock.innerHTML);
				const ref = wpId && options.mediaMap?.get(wpId);

				images.push({
					_type: "image",
					_key: context.generateKey(),
					asset: {
						_type: "reference",
						_ref: ref || String(wpId || src || ""),
						url: src,
					},
					alt,
					caption,
				});
			}
		}
	} else {
		// Parse from HTML (older gallery format)
		let match;
		while ((match = IMG_TAG_GLOBAL.exec(block.innerHTML)) !== null) {
			const imgHtml = match[0];
			const src = extractSrc(imgHtml);
			const alt = extractAlt(imgHtml);
			const idMatch = imgHtml.match(DATA_ID_PATTERN);
			const wpId = idMatch?.[1] ? parseInt(idMatch[1], 10) : undefined;
			const ref = wpId && options.mediaMap?.get(wpId);

			images.push({
				_type: "image",
				_key: context.generateKey(),
				asset: {
					_type: "reference",
					_ref: ref || String(wpId || src || ""),
					url: src,
				},
				alt,
			});
		}
	}

	return [
		{
			_type: "gallery",
			_key: context.generateKey(),
			images,
			columns: attrNumber(block.attrs, "columns"),
		},
	];
};

/**
 * core/columns → columns block
 */
export const columns: BlockTransformer = (block, _options, context) => {
	const columnBlocks = block.innerBlocks.map((col) => ({
		_type: "column" as const,
		_key: context.generateKey(),
		content: context.transformBlocks(col.innerBlocks),
	}));

	return [
		{
			_type: "columns",
			_key: context.generateKey(),
			columns: columnBlocks,
		},
	];
};

/**
 * core/group → flatten children (no special container)
 */
export const group: BlockTransformer = (block, _options, context) => {
	return context.transformBlocks(block.innerBlocks);
};

/**
 * core/table → table block
 */
export const table: BlockTransformer = (block, _options, context) => {
	// Parse the table HTML
	const tableMatch = findTagPairs(block.innerHTML, ["table"], 1)[0];
	if (!tableMatch) {
		return [];
	}

	const tableContent = tableMatch.content;

	// Check for thead
	const theadMatch = findTagPairs(tableContent, ["thead"], 1)[0];
	const tbodyMatch = findTagPairs(tableContent, ["tbody"], 1)[0];

	const rows: Array<{
		_type: "tableRow";
		_key: string;
		cells: Array<{
			_type: "tableCell";
			_key: string;
			content: import("../types.js").PortableTextSpan[];
			markDefs?: import("../types.js").PortableTextMarkDef[];
			isHeader?: boolean;
		}>;
	}> = [];

	// Parse header rows
	if (theadMatch?.content) {
		const headerRows = parseTableRows(theadMatch.content, context, true);
		rows.push(...headerRows);
	}

	// Parse body rows
	if (tbodyMatch?.content) {
		const bodyRows = parseTableRows(tbodyMatch.content, context, false);
		rows.push(...bodyRows);
	} else if (!theadMatch) {
		// No thead or tbody, parse rows directly
		const directRows = parseTableRows(tableContent, context, false);
		rows.push(...directRows);
	}

	if (rows.length === 0) {
		return [];
	}

	return [
		{
			_type: "table" as const,
			_key: context.generateKey(),
			rows,
			hasHeaderRow: !!theadMatch || rows[0]!.cells.every((cell) => cell.isHeader === true),
		},
	];
};

/**
 * Parse table rows from HTML
 */
function parseTableRows(
	html: string,
	context: import("../types.js").TransformContext,
	isHeader: boolean,
): Array<{
	_type: "tableRow";
	_key: string;
	cells: Array<{
		_type: "tableCell";
		_key: string;
		content: import("../types.js").PortableTextSpan[];
		markDefs?: import("../types.js").PortableTextMarkDef[];
		isHeader?: boolean;
	}>;
}> {
	const rows: Array<{
		_type: "tableRow";
		_key: string;
		cells: Array<{
			_type: "tableCell";
			_key: string;
			content: import("../types.js").PortableTextSpan[];
			markDefs?: import("../types.js").PortableTextMarkDef[];
			isHeader?: boolean;
		}>;
	}> = [];

	for (const rowMatch of findTagPairs(html, ["tr"])) {
		const rowContent = rowMatch.content;
		const cells: Array<{
			_type: "tableCell";
			_key: string;
			content: import("../types.js").PortableTextSpan[];
			markDefs?: import("../types.js").PortableTextMarkDef[];
			isHeader?: boolean;
		}> = [];

		// Match both th and td cells
		for (const cellMatch of findTagPairs(rowContent, ["th", "td"])) {
			const isHeaderCell = cellMatch.name === "th" || isHeader;
			const cellContent = cellMatch.content;

			const { children, markDefs } = context.parseInlineContent(cellContent);

			cells.push({
				_type: "tableCell" as const,
				_key: context.generateKey(),
				content: children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
				isHeader: isHeaderCell || undefined,
			});
		}

		if (cells.length > 0) {
			rows.push({
				_type: "tableRow" as const,
				_key: context.generateKey(),
				cells,
			});
		}
	}

	return rows;
}

interface TagPair {
	name: string;
	content: string;
}

/**
 * Finds `<name ...>content</name>` pairs in document order with the same
 * results as the lazy regex `/<(name)[^>]*>([\s\S]*?)<\/\1>/gi`: each opening
 * tag ends at the first `>` and pairs with the first closing tag of the same
 * name, ignoring nesting. Names must be lowercase; they match ASCII
 * case-insensitively and without a word boundary, so `th` also matches
 * `<thead>`.
 *
 * Once an opening tag finds no closing tag, no later tag of that name can
 * either, so the name is dropped. Retrying it from every later position would
 * make unclosed markup quadratic.
 */
function findTagPairs(html: string, names: readonly string[], limit = Infinity): TagPair[] {
	const pairs: TagPair[] = [];
	const closable = new Set(names);
	let lt = html.indexOf("<");
	while (lt !== -1 && pairs.length < limit && closable.size > 0) {
		const name = names.find((n) => closable.has(n) && matchesLowercase(html, lt + 1, n));
		if (name !== undefined) {
			const openEnd = html.indexOf(">", lt + 1 + name.length);
			if (openEnd === -1) {
				break;
			}
			const closeStart = indexOfCloseTag(html, name, openEnd + 1);
			if (closeStart !== -1) {
				pairs.push({ name, content: html.slice(openEnd + 1, closeStart) });
				lt = html.indexOf("<", closeStart + name.length + 3);
				continue;
			}
			closable.delete(name);
		}
		lt = html.indexOf("<", lt + 1);
	}
	return pairs;
}

function indexOfCloseTag(html: string, name: string, from: number): number {
	let i = html.indexOf("</", from);
	while (i !== -1) {
		if (matchesLowercase(html, i + 2, name) && html[i + 2 + name.length] === ">") {
			return i;
		}
		i = html.indexOf("</", i + 1);
	}
	return -1;
}

function matchesLowercase(html: string, at: number, lowercase: string): boolean {
	for (let i = 0; i < lowercase.length; i++) {
		const charCode = html.charCodeAt(at + i);
		const folded = charCode >= 65 && charCode <= 90 ? charCode + 32 : charCode;
		if (folded !== lowercase.charCodeAt(i)) {
			return false;
		}
	}
	return true;
}

/**
 * Convert a heading level number to a PortableTextTextBlock style
 */
function toHeadingStyle(level: number): PortableTextTextBlock["style"] {
	switch (level) {
		case 1:
			return "h1";
		case 2:
			return "h2";
		case 3:
			return "h3";
		case 4:
			return "h4";
		case 5:
			return "h5";
		case 6:
			return "h6";
		default:
			return "h2";
	}
}

/**
 * Map WordPress alignment to Portable Text alignment
 */
function mapAlignment(
	align: string | undefined,
): "left" | "center" | "right" | "wide" | "full" | undefined {
	switch (align) {
		case "left":
		case "center":
		case "right":
		case "wide":
		case "full":
			return align;
		default:
			return undefined;
	}
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(html: string): string {
	return html
		.replace(LT_ENTITY_PATTERN, "<")
		.replace(GT_ENTITY_PATTERN, ">")
		.replace(AMP_ENTITY_PATTERN, "&")
		.replace(QUOT_ENTITY_PATTERN, '"')
		.replace(APOS_ENTITY_PATTERN, "'")
		.replace(NBSP_ENTITY_PATTERN, " ");
}

function toButton(block: GutenbergBlock, context: TransformContext): PortableTextButtonBlock {
	// WordPress stores the button link in the markup, not in the block comment attributes
	const rawUrl =
		attrString(block.attrs, "url") ||
		decodeUrlEntities(block.innerHTML.match(ANCHOR_HREF_PATTERN)?.[1] ?? "");
	const text = extractText(block.innerHTML).trim() || "Button";

	let style: "default" | "outline" | "fill" = "default";
	const className = attrString(block.attrs, "className");
	if (className?.includes("is-style-outline")) {
		style = "outline";
	} else if (className?.includes("is-style-fill")) {
		style = "fill";
	}

	return {
		_type: "button",
		_key: context.generateKey(),
		text,
		url: sanitizeHref(rawUrl),
		style,
	};
}

/**
 * core/button → button block
 */
export const button: BlockTransformer = (block, _options, context) => [toButton(block, context)];

/**
 * core/buttons → buttons container block
 */
export const buttons: BlockTransformer = (block, _options, context) => {
	const buttonBlocks = block.innerBlocks
		.filter((innerBlock) => innerBlock.blockName === "core/button")
		.map((innerBlock) => toButton(innerBlock, context));

	// Detect layout from attrs
	const layoutObj = attrObject(block.attrs, "layout");
	const layout =
		layoutObj && typeof layoutObj["type"] === "string" && layoutObj["type"] === "flex"
			? "horizontal"
			: "vertical";

	return [
		{
			_type: "buttons",
			_key: context.generateKey(),
			buttons: buttonBlocks,
			layout: layout,
		},
	];
};

/**
 * core/cover → cover block
 */
export const cover: BlockTransformer = (block, _options, context) => {
	const url = attrString(block.attrs, "url");
	const overlayColor = attrString(block.attrs, "overlayColor");
	const customOverlayColor = attrString(block.attrs, "customOverlayColor");
	const dimRatio = attrNumber(block.attrs, "dimRatio");
	const minHeight = attrNumber(block.attrs, "minHeight");
	const minHeightUnit = attrString(block.attrs, "minHeightUnit");
	const contentPosition = attrString(block.attrs, "contentPosition");

	// Transform inner blocks for content
	const content = context.transformBlocks(block.innerBlocks);

	// Determine alignment from content position
	let alignment: "left" | "center" | "right" | undefined;
	if (contentPosition?.includes("left")) alignment = "left";
	else if (contentPosition?.includes("right")) alignment = "right";
	else if (contentPosition?.includes("center")) alignment = "center";

	// Build min height string
	let minHeightStr: string | undefined;
	if (minHeight !== undefined) {
		minHeightStr = minHeightUnit ? `${minHeight}${minHeightUnit}` : `${minHeight}px`;
	}

	return [
		{
			_type: "cover",
			_key: context.generateKey(),
			backgroundImage: url,
			overlayColor: customOverlayColor || overlayColor,
			overlayOpacity: dimRatio !== undefined ? dimRatio / 100 : undefined,
			content,
			minHeight: minHeightStr,
			alignment,
		},
	];
};

/**
 * core/file → file block
 */
export const file: BlockTransformer = (block, _options, context) => {
	const href = sanitizeHref(attrString(block.attrs, "href"));
	const fileName = attrString(block.attrs, "fileName");
	const showDownloadButton = attrBoolean(block.attrs, "showDownloadButton");

	// Try to extract href from HTML if not in attrs
	let url = href;
	if (!url) {
		const hrefMatch = block.innerHTML.match(HREF_PATTERN);
		url = sanitizeHref(hrefMatch?.[1]);
	}

	// Try to extract filename from HTML if not in attrs
	let filename = fileName;
	if (!filename && url) {
		filename = url.split("/").pop()?.split("?")[0];
	}

	return [
		{
			_type: "file",
			_key: context.generateKey(),
			url: url || "",
			filename,
			showDownloadButton: showDownloadButton !== false,
		},
	];
};

/**
 * core/pullquote → pullquote block
 */
export const pullquote: BlockTransformer = (block, _options, context) => {
	// Extract text from blockquote > p
	const pMatch = block.innerHTML.match(P_TAG_SINGLE_PATTERN);
	const text = pMatch ? extractText(pMatch[1]!) : extractText(block.innerHTML);

	// Extract citation
	const citeMatch = block.innerHTML.match(CITE_TAG_PATTERN);
	const citation = citeMatch ? extractText(citeMatch[1]!) : attrString(block.attrs, "citation");

	return [
		{
			_type: "pullquote",
			_key: context.generateKey(),
			text: text.trim(),
			citation: citation?.trim(),
		},
	];
};

/**
 * core/html → htmlBlock (pass through)
 */
export const html: BlockTransformer = (block, _options, context) => {
	return [
		{
			_type: "htmlBlock",
			_key: context.generateKey(),
			html: block.innerHTML.trim(),
			originalBlockName: "core/html",
		},
	];
};

/**
 * core/verse → code block (preserves whitespace like preformatted)
 */
export const verse: BlockTransformer = (block, _options, context) => {
	const text = extractText(block.innerHTML);

	return [
		{
			_type: "code",
			_key: context.generateKey(),
			code: text,
			language: "text", // Mark as plain text
		},
	];
};

/**
 * core/more → break block with "readMore" style
 */
export const more: BlockTransformer = (_block, _options, context) => {
	return [
		{
			_type: "break",
			_key: context.generateKey(),
			style: "lineBreak", // Could be "readMore" if we add that type
		},
	];
};

/**
 * core/nextpage → break block with page break indicator
 */
export const nextpage: BlockTransformer = (_block, _options, context) => {
	return [
		{
			_type: "break",
			_key: context.generateKey(),
			style: "lineBreak", // Could be "pageBreak" if we add that type
		},
	];
};

/**
 * core/shortcode → htmlBlock (preserve for manual handling)
 */
export const shortcode: BlockTransformer = (block, _options, context) => {
	return [
		{
			_type: "htmlBlock",
			_key: context.generateKey(),
			html: block.innerHTML.trim(),
			originalBlockName: "core/shortcode",
		},
	];
};

/**
 * core/media-text → columns block with 2 columns
 */
export const mediaText: BlockTransformer = (block, _options, context) => {
	const mediaId = attrNumber(block.attrs, "mediaId");
	const mediaUrl = attrString(block.attrs, "mediaUrl");
	const mediaType = attrString(block.attrs, "mediaType");
	const mediaPosition = attrString(block.attrs, "mediaPosition");
	const mediaAlt = attrString(block.attrs, "mediaAlt");

	// Create media column
	const mediaBlock: PortableTextBlock[] =
		mediaType === "video"
			? [
					{
						_type: "embed",
						_key: context.generateKey(),
						url: mediaUrl || "",
						provider: "video",
					},
				]
			: [
					{
						_type: "image",
						_key: context.generateKey(),
						asset: {
							_type: "reference",
							_ref: String(mediaId || mediaUrl || ""),
							url: mediaUrl,
						},
						alt: mediaAlt,
					},
				];

	// Transform content blocks
	const contentBlocks = context.transformBlocks(block.innerBlocks);

	// Order based on media position
	const mediaTextColumns =
		mediaPosition === "right"
			? [
					{ _type: "column" as const, _key: context.generateKey(), content: contentBlocks },
					{ _type: "column" as const, _key: context.generateKey(), content: mediaBlock },
				]
			: [
					{ _type: "column" as const, _key: context.generateKey(), content: mediaBlock },
					{ _type: "column" as const, _key: context.generateKey(), content: contentBlocks },
				];

	return [
		{
			_type: "columns",
			_key: context.generateKey(),
			columns: mediaTextColumns,
		},
	];
};
