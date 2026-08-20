import type {
	ForgeHostTransport,
	ForgePrepareRequest,
	ForgePrepareResponse,
	ForgeProfileSummary,
	ForgeResolveProfileRequest,
	ForgeResolveProfileResponse,
} from "@zihanw/pi-forge/subagent";
import {
	ForgeHostClient,
	validateListProfilesResponse,
	validatePrepareResponse,
	validateResolveProfileResponse,
	type ForgeHostConnection,
} from "@zihanw/pi-forge/subagent";

export interface ForgeHostSessionOptions {
	defaultTimeoutMs?: number;
	discoverSettleMs?: number;
}

/**
 * A discovered, connected session to the active pi-forge host over the
 * versioned `/subagent` host port. The optional package depends only on the
 * published host-port names in `@zihanw/pi-forge/subagent`; it never imports
 * main-package internals (workspace, subagent-host, loaders, compiler).
 */
export class ForgeHostSession {
	private readonly client: ForgeHostClient;
	private connection?: ForgeHostConnection;
	private readonly unavailableHandlers = new Set<() => void>();
	private lastClientUnavailable?: () => void;

	private constructor(transport: ForgeHostTransport, options: ForgeHostSessionOptions = {}) {
		this.client = new ForgeHostClient(transport, options);
	}

	static async connect(transport: ForgeHostTransport, options: ForgeHostSessionOptions = {}): Promise<ForgeHostSession> {
		const session = new ForgeHostSession(transport, options);
		await session.refresh();
		return session;
	}

	get hostId(): string | undefined {
		return this.connection?.hostId;
	}

	get generation(): number | undefined {
		return this.connection?.generation;
	}

	onUnavailable(handler: () => void): () => void {
		this.unavailableHandlers.add(handler);
		if (this.lastClientUnavailable === undefined && this.connection) {
			this.lastClientUnavailable = this.client.onUnavailable(() => {
				this.connection = undefined;
				for (const handler of [...this.unavailableHandlers]) handler();
			});
		}
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			this.unavailableHandlers.delete(handler);
		};
	}

	/** Re-discover and (re)connect to the host, replacing any prior connection. */
	async refresh(): Promise<void> {
		if (this.connection) {
			this.client.disconnect();
			this.connection = undefined;
			this.lastClientUnavailable = undefined;
		}
		this.connection = this.client.connect(await this.client.discover());
		if (this.unavailableHandlers.size > 0) {
			const connection = this.connection;
			this.lastClientUnavailable = this.client.onUnavailable(() => {
				this.connection = undefined;
				for (const handler of [...this.unavailableHandlers]) handler();
			});
			void connection;
		}
	}

	async listProfiles(): Promise<ForgeProfileSummary[]> {
		const connection = this.requireConnection();
		const result = await this.client.request(connection, "listProfiles", {});
		if (!result.ok) throw new Error(result.error);
		const validated = validateListProfilesResponse(result.data);
		if (!validated.ok) throw new Error(validated.error);
		return validated.data.profiles;
	}

	async resolveProfile(selector: string): Promise<ForgeResolveProfileResponse> {
		const connection = this.requireConnection();
		const request: ForgeResolveProfileRequest = { profile: selector };
		const result = await this.client.request(connection, "resolveProfile", request);
		if (!result.ok) throw new Error(result.error);
		const validated = validateResolveProfileResponse(result.data);
		if (!validated.ok) throw new Error(validated.error);
		return validated.data;
	}

	async prepare(request: ForgePrepareRequest): Promise<ForgePrepareResponse> {
		const connection = this.requireConnection();
		const result = await this.client.request(connection, "prepare", request);
		if (!result.ok) throw new Error(result.error);
		const validated = validatePrepareResponse(result.data);
		if (!validated.ok) throw new Error(validated.error);
		return validated.data;
	}

	dispose(): void {
		this.client.disconnect();
		this.connection = undefined;
		this.unavailableHandlers.clear();
	}

	private requireConnection(): ForgeHostConnection {
		if (!this.connection) throw new Error("Forge host session is not connected.");
		return this.connection;
	}
}
