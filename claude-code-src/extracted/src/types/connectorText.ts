// Stub — connector text type not available in edward build
export function isConnectorTextBlock(_block: unknown): boolean { return false; }
export function extractConnectorText(_block: unknown): string { return ''; }
export type ConnectorTextBlock = { type: 'connector_text'; text: string };
