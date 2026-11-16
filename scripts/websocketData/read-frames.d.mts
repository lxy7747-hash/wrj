export function readMockFrames(file?: string | URL): Array<Record<string, unknown> & { msg_type: 'frame_snapshot'; frame_id: number }>
