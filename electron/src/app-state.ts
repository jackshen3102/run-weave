let quitting = false;

export function setIsQuitting(value: boolean): void {
  quitting = value;
}

export function getIsQuitting(): boolean {
  return quitting;
}
