const replacements = new Map<string, string>()

export function replaceDraftOwner(pendingId: string, realId: string): void {
  replacements.set(pendingId, realId)
}

export function resolveDraftOwner(id: string | null): string | null {
  return id ? (replacements.get(id) ?? id) : null
}
