import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MODES = {
	".js": "c", ".mjs": "c", ".cjs": "c", ".jsx": "c",
	".ts": "c", ".mts": "c", ".cts": "c", ".tsx": "c",
	".jsonc": "c",
	".css": "css",
	".html": "html", ".htm": "html",
	".yml": "hash", ".yaml": "hash", ".sh": "shell", ".bash": "shell", ".toml": "anyhash", ".py": "python",
	".sql": "dash",
};

export const GENERATED = ["**/node_modules/**", "**/dist/**", "**/vendor/**", "**/worker-configuration.d.ts"];

const DIRECTIVES = [
	/^\/\/\s*@ts-/, /^\/\/\/\s*<reference/, /^\/\/\s*@vitest-environment/, /^\/\/#\s*source(Mapping)?URL=/,
	/^\/[/*]\s*(eslint|oxlint|biome-ignore|prettier-ignore|deno-|istanbul|c8|v8 ignore|@jsx|@__PURE__|#__PURE__)/,
	/^\/\*\s*(glsl|wgsl|html|css|sql|graphql|gql|svg|md)\s*\*\/$/i,
	/^\/[/*]\s*nosemgrep\b/, /^#\s*nosemgrep\b/, /^--\s*nosemgrep\b/,
	/^\/\*!/, /^\/[/*]\s*(SPDX-License-Identifier|Copyright)/i,
	/^<!--\s*prettier-ignore/,
	/^#!/, /^#\s*(shellcheck|yaml-language-server:|syntax=|SPDX-License-Identifier|Copyright)/i,
];

const PIN_CODE = /^\s*(-\s+)?uses:\s*["']?[\w.\/-]+@[0-9a-f]{40}["']?\s*$/;
const PIN_COMMENT = /^#\s*v?[\w.-]+\s*$/;

const isDirective = (text) => DIRECTIVES.some((re) => re.test(text));

const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

function scanC(src, css) {
	const lines = [];
	const mark = (line, kind) => {
		const l = (lines[line] ??= { comment: false, code: false });
		l[kind] = true;
	};
	let line = 0;
	let prev = "";
	let word = "";
	let property = false;
	const braces = [];
	let i = 0;
	const n = src.length;
	const string = (q) => {
		mark(line, "code");
		i++;
		while (i < n && src[i] !== q && src[i] !== "\n") {
			if (src[i] === "\\") i++;
			i++;
		}
		i++;
		prev = "a";
	};
	const template = () => {
		mark(line, "code");
		i++;
		while (i < n) {
			const ch = src[i];
			if (ch === "\\") { i += 2; continue; }
			if (ch === "\n") { line++; i++; continue; }
			mark(line, "code");
			if (ch === "`") { i++; prev = "a"; return; }
			if (ch === "$" && src[i + 1] === "{") { i += 2; braces.push(0); prev = "{"; return; }
			i++;
		}
	};
	while (i < n) {
		const ch = src[i];
		const next = src[i + 1];
		if (ch === "\n") { line++; i++; continue; }
		if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
		if (ch === "/" && next === "/" && !css) {
			const end = src.indexOf("\n", i);
			const text = src.slice(i, end < 0 ? n : end);
			if (!isDirective(text)) mark(line, "comment");
			i = end < 0 ? n : end;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end < 0 ? n : end + 2;
			const text = src.slice(i, stop);
			const directive = isDirective(text);
			for (let k = i; k < stop; k++) {
				if (src[k] === "\n") line++;
				else if (!directive && src[k] !== " " && src[k] !== "\t" && src[k] !== "\r") mark(line, "comment");
			}
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'") { string(ch); word = ""; continue; }
		if (ch === "`" && !css) { template(); word = ""; continue; }
		if (!css && braces.length && ch === "}" && braces.at(-1) === 0) { braces.pop(); i--; template(); continue; }
		if (!css && braces.length && ch === "{") braces[braces.length - 1]++;
		if (!css && braces.length && ch === "}") braces[braces.length - 1]--;
		if (ch === "/" && !css && (REGEX_AFTER.has(prev) || (REGEX_KEYWORDS.has(word) && !property))) {
			mark(line, "code");
			i++;
			let inClass = false;
			while (i < n && src[i] !== "\n") {
				if (src[i] === "\\") { i += 2; continue; }
				if (src[i] === "[") inClass = true;
				else if (src[i] === "]") inClass = false;
				else if (src[i] === "/" && !inClass) break;
				i++;
			}
			i++;
			while (i < n && /[a-z]/i.test(src[i])) i++;
			prev = "a";
			word = "";
			continue;
		}
		mark(line, "code");
		if (/[\w$]/.test(ch)) {
			if (prev === "a") word += ch;
			else {
				property = prev === ".";
				word = ch;
			}
			prev = "a";
		} else {
			word = "";
			prev = (ch === "+" || ch === "-") && src[i - 1] === ch ? "a" : ch;
		}
		i++;
	}
	return lines;
}

function scanHtml(src) {
	const lines = [];
	const mark = (line, kind) => {
		(lines[line] ??= { comment: false, code: false })[kind] = true;
	};
	const merge = (inner, offset) => {
		inner.forEach((l, k) => {
			if (l?.comment) mark(offset + k, "comment");
			if (l?.code) mark(offset + k, "code");
		});
	};
	let line = 0;
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("<!--", i)) {
			const end = src.indexOf("-->", i);
			const stop = end < 0 ? src.length : end + 3;
			const directive = isDirective(src.slice(i, stop));
			for (let k = i; k < stop; k++) {
				if (src[k] === "\n") line++;
				else if (!directive && !/\s/.test(src[k])) mark(line, "comment");
			}
			i = stop;
			continue;
		}
		const tag = /^<(script|style)\b[^>]*>/i.exec(src.slice(i, i + 2000));
		if (tag) {
			for (let k = i; k < i + tag[0].length; k++) {
				if (src[k] === "\n") line++;
				else if (!/\s/.test(src[k])) mark(line, "code");
			}
			i += tag[0].length;
			const close = src.toLowerCase().indexOf(`</${tag[1].toLowerCase()}`, i);
			const stop = close < 0 ? src.length : close;
			const body = src.slice(i, stop);
			merge(scanC(body, tag[1].toLowerCase() === "style"), line);
			line += body.split("\n").length - 1;
			i = stop;
			continue;
		}
		if (src[i] === "\n") line++;
		else if (!/\s/.test(src[i])) mark(line, "code");
		i++;
	}
	return lines;
}

function scanHash(src, marker = "#", after = /\s/) {
	return src.split("\n").map((text, index) => {
		let quote = "";
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === "\\" && quote === '"') i++;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === '"' || (ch === "'" && !/[\w]/.test(text[i - 1] ?? ""))) { quote = ch; continue; }
			if (text.startsWith(marker, i) && (i === 0 || after.test(text[i - 1]))) {
				const comment = text.slice(i);
				const code = text.slice(0, i).trim() !== "";
				if ((index === 0 && comment.startsWith("#!")) || isDirective(comment) || (PIN_CODE.test(text.slice(0, i)) && PIN_COMMENT.test(comment))) return { comment: false, code };
				return { comment: true, code };
			}
		}
		return { comment: false, code: text.trim() !== "" };
	});
}

function scanShell(src) {
	const out = [];
	let quote = "";
	let heredoc = null;
	src.split("\n").forEach((text, index) => {
		const l = { comment: false, code: text.trim() !== "" };
		out.push(l);
		if (heredoc) {
			if ((heredoc.dash ? text.replace(/^\t+/, "") : text) === heredoc.tag) heredoc = null;
			return;
		}
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === "\\" && quote === '"') i++;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === "\\") { i++; continue; }
			if (ch === '"' || ch === "'") { quote = ch; continue; }
			const doc = /^<<(-?)\s*(['"]?)(\w+)\2/.exec(text.slice(i));
			if (doc) {
				heredoc = { dash: doc[1] === "-", tag: doc[3] };
				i += doc[0].length - 1;
				continue;
			}
			if (ch === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
				const comment = text.slice(i);
				l.code = text.slice(0, i).trim() !== "";
				l.comment = !((index === 0 && comment.startsWith("#!")) || isDirective(comment));
				return;
			}
		}
	});
	return out;
}

function scanPython(src) {
	const out = [];
	let quote = "";
	src.split("\n").forEach((text, index) => {
		const l = { comment: false, code: text.trim() !== "" };
		out.push(l);
		for (let i = 0; i < text.length; i++) {
			if (quote) {
				if (text[i] === "\\") i++;
				else if (text.startsWith(quote, i)) {
					i += quote.length - 1;
					quote = "";
				}
				continue;
			}
			const ch = text[i];
			if (ch === '"' || ch === "'") {
				quote = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
				i += quote.length - 1;
				continue;
			}
			if (ch === "#") {
				const comment = text.slice(i);
				l.code = text.slice(0, i).trim() !== "";
				l.comment = !((index === 0 && comment.startsWith("#!")) || isDirective(comment) || /^#\s*(type:|noqa|pragma|pylint:|fmt:|-\*-)/.test(comment));
				return;
			}
		}
		if (quote.length === 1) quote = "";
	});
	return out;
}

export function commentLines(path, src) {
	const mode = MODES[extname(path).toLowerCase()];
	if (!mode) return { lines: 0, whole: 0 };
	const lines =
		mode === "hash" ? scanHash(src)
		: mode === "shell" ? scanShell(src)
		: mode === "python" ? scanPython(src)
		: mode === "anyhash" ? scanHash(src, "#", /[^]/)
		: mode === "dash" ? scanHash(src, "--", /[^-]/)
		: mode === "html" ? scanHtml(src)
		: scanC(src, mode === "css");
	const source = src.split("\n");
	source.forEach((text, k) => {
		if (k > 0 && /\bnosemgrep\b/.test(text) && lines[k - 1]?.comment && !lines[k - 1].code && !/\bnosemgrep\b/.test(source[k - 1])) lines[k - 1].comment = false;
	});
	let count = 0;
	let whole = 0;
	for (const l of lines) {
		if (!l?.comment) continue;
		count++;
		if (!l.code) whole++;
	}
	return { lines: count, whole };
}

export function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
		else if (ch === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
		else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

export function judge(counts, baseline) {
	const over = [];
	const under = [];
	for (const [file, { lines }] of Object.entries(counts)) {
		const allowed = baseline[file] ?? 0;
		if (lines > allowed) over.push(`${file}: ${lines} code comment lines, the baseline allows ${allowed}`);
		else if (lines < allowed) under.push(`${file}: ${lines} code comment lines, the baseline still allows ${allowed}`);
	}
	for (const [file, allowed] of Object.entries(baseline)) {
		if (!(file in counts) && allowed > 0) under.push(`${file}: gone or exempt, the baseline still allows ${allowed}`);
	}
	return { over: over.sort(), under: under.sort() };
}

function main(args) {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	const baselinePath = resolve(root, ".comment-baseline.json");
	const config = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { ignore: [], files: {} };
	const ignore = [...GENERATED, ...(config.ignore ?? [])].map(globToRegExp);
	const only = (config.only ?? []).map(globToRegExp);
	const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
	const counts = {};
	for (const file of files) {
		if (!MODES[extname(file).toLowerCase()] || ignore.some((re) => re.test(file))) continue;
		if (only.length && !only.some((re) => re.test(file))) continue;
		const path = resolve(root, file);
		if (!existsSync(path)) continue;
		const c = commentLines(file, readFileSync(path, "utf8"));
		if (c.lines) counts[file] = c;
	}
	if (args.includes("--report")) {
		const total = Object.values(counts).reduce((a, c) => ({ lines: a.lines + c.lines, whole: a.whole + c.whole }), { lines: 0, whole: 0 });
		for (const [file, c] of Object.entries(counts).sort(([, a], [, b]) => b.lines - a.lines)) console.log(`${String(c.lines).padStart(5)} ${String(c.whole).padStart(5)}  ${file}`);
		console.log(`${total.lines} code comment lines in ${Object.keys(counts).length} files; deleting them all sheds ${total.whole} lines (the rest share a line with code).`);
		return 0;
	}
	const baseline = config.files ?? {};
	const { over, under } = judge(counts, baseline);
	if (args.includes("--update")) {
		if (over.length && existsSync(baselinePath)) {
			console.log("::error::The code comment baseline only goes down. Delete these code comments instead:");
			for (const l of over) console.log(`  ${l}`);
			return 1;
		}
		const files = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([f, c]) => [f, c.lines]));
		writeFileSync(baselinePath, `${JSON.stringify({ ...config, files }, null, "\t")}\n`);
		console.log(`code comment baseline: ${Object.values(files).reduce((a, b) => a + b, 0)} lines in ${Object.keys(files).length} files`);
		return 0;
	}
	if (over.length) {
		console.log("::error::New code comments. Delete them; a decision goes in docs/adr/ (see .claude/skills/delete-comment):");
		for (const l of over) console.log(`  ${l}`);
	}
	if (under.length) {
		console.log("::error::Code comments were deleted; lower the baseline with `node scripts/comment-ratchet.mjs --update`:");
		for (const l of under) console.log(`  ${l}`);
	}
	if (over.length || under.length) return 1;
	console.log(`code comments within the baseline (${Object.keys(counts).length} files still carry some)`);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
