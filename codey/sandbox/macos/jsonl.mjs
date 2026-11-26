// Read bounded LF-delimited protocol frames without buffering oversized input.
export async function readFrames(input, maxRequest, onFrame, tooLarge) {
	let parts = [], size = 0;
	for await (const chunk of input) {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline;
			if (size <= maxRequest) {
				size += end - offset;
				if (size > maxRequest) {
					parts = [];
					tooLarge();
				} else if (end !== offset) parts.push(chunk.subarray(offset, end));
			}
			if (newline < 0) break;
			if (size && size <= maxRequest) onFrame(Buffer.concat(parts, size));
			parts = [];
			size = 0;
			offset = newline + 1;
		}
	}
}
