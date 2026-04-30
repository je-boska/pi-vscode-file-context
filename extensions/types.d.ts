declare module "@mariozechner/pi-coding-agent" {
	export interface ExtensionContext {
		cwd: string;
		ui: {
			setStatus(key: string, value: string): void;
		};
	}

	export interface ExtensionAPI {
		on(
			event: string,
			handler: (
				event: unknown,
				ctx: ExtensionContext,
			) => unknown | Promise<unknown>,
		): void;
		registerTool(tool: ToolDefinition): void;
	}

	export interface ToolDefinition {
		name: string;
		label?: string;
		description?: string;
		parameters: unknown;
		execute(
			id: string,
			params: unknown,
			signal: AbortSignal,
			onUpdate: unknown,
			ctx: ExtensionContext,
		): unknown | Promise<unknown>;
	}
}

declare module "typebox" {
	export const Type: {
		Object(schema: Record<string, unknown>): unknown;
	};
}
