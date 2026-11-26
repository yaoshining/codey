// Terminal adaptation of docs/assets/codey-mark.svg.
import { backgroundAnsi, foregroundAnsi, rgbColor, styleText } from "@earendil-works/pi-tui";
import { codeyVersion } from "./version.mjs";

const pixels = [
	" ...... ",
	"........",
	"..CCC...",
	".C...>..",
	".C....>.",
	".C...>..",
	"..CCC...",
	" ...... ",
];

const palette = {
	surface: rgbColor(21, 27, 36),
	mark: rgbColor(242, 245, 248),
	accent: rgbColor(255, 184, 101),
	info: { dark: rgbColor(139, 192, 255), light: rgbColor(0, 77, 142) },
};
const colors = { ".": palette.surface, C: palette.mark, ">": palette.accent };
const colorEnabled = () => !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0" && process.env.TERM !== "dumb";

export function styleReviewMarker(text, theme) {
	const style = { fg: palette.accent, bg: palette.surface };
	return colorEnabled() ? (theme ? theme.style(text, style) : styleText(text, style, "truecolor")) : text;
}

export function styleInfo(text, theme) {
	if (!colorEnabled()) return text;
	const style = { fg: palette.info[theme?.appearance ?? "dark"] };
	return theme ? theme.style(text, style) : styleText(text, style, "truecolor");
}

function logoLines(mode) {
	if (!colorEnabled()) return [];
	const lines = [];
	for (let row = 0; row < pixels.length; row += 2) {
		let line = "";
		for (let col = 0; col < pixels[row].length; col++) {
			const top = colors[pixels[row][col]];
			const bottom = colors[pixels[row + 1][col]];
			if (top && bottom) line += foregroundAnsi(top, mode) + backgroundAnsi(bottom, mode) + "▀\x1b[0m";
			else if (top || bottom) line += foregroundAnsi(top ?? bottom, mode) + (top ? "▀" : "▄") + "\x1b[0m";
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}

export const branding = {
	commandName: "codey",
	title: "Codey",
	version: codeyVersion,
	logoLines,
	projectTrustDescription:
		"This allows Codey to load project settings and resources, install missing project packages, and execute project extensions.",
};
