import { getPiUserAgent } from "./pi-user-agent.ts";

const DEFAULT_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const LATEST_VERSION_URL = process.env.PI_UPDATE_URL || DEFAULT_LATEST_VERSION_URL;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	// Support GitHub releases: PI_UPDATE_URL=https://github.com/user/repo
	if (LATEST_VERSION_URL.startsWith("https://github.com/")) {
		return getLatestReleaseFromGithub(LATEST_VERSION_URL, options);
	}

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

async function getLatestReleaseFromGithub(
	repoUrl: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	// Extract owner/repo from URL
	const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
	if (!match) return undefined;
	const repo = match[1];

	const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"User-Agent": getPiUserAgent(""),
	};
	if (process.env.GITHUB_TOKEN) {
		headers.authorization = `token ${process.env.GITHUB_TOKEN}`;
	}

	const response = await fetch(apiUrl, {
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		tag_name?: unknown;
		body?: unknown;
		assets?: Array<{ name: string; browser_download_url: string }>;
	};

	if (typeof data.tag_name !== "string") return undefined;
	const version = data.tag_name.replace(/^v/, "");

	// Find the tgz asset
	const tgzAsset = data.assets?.find((a) => a.name.endsWith(".tgz"));
	const packageName = tgzAsset?.name
		.replace(/-\d+\.\d+\.\d+\.tgz$/, "")
		.replace(/\./g, "-");

	const note = typeof data.body === "string" ? data.body.slice(0, 500) : undefined;

	return {
		version,
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
