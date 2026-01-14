export function uuidToBinary(uuid: string): Buffer {
    const hex = uuid.replace(/-/g, '');
    return Buffer.from(hex, 'hex');
}

export function binaryToUuid(binary: Buffer): string {
    const hex = binary.toString('hex');
    return [
        hex.substring(0, 8),
        hex.substring(8, 12),
        hex.substring(12, 16),
        hex.substring(16, 20),
        hex.substring(20, 32)
    ].join('-');
}
