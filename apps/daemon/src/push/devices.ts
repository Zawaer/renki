/**
 * Tracks which devices currently have a live WebSocket connection, ref-counted
 * so multiple tabs/connections from the same device are handled correctly.
 *
 * Used by the push notifier to decide whether to bother sending a push: if the
 * device is actively connected it already sees everything live, so we stay
 * quiet and only notify devices that are away.
 */
export class DeviceRegistry {
  private readonly counts = new Map<string, number>();

  connect(deviceId: string): void {
    this.counts.set(deviceId, (this.counts.get(deviceId) ?? 0) + 1);
  }

  disconnect(deviceId: string): void {
    const n = (this.counts.get(deviceId) ?? 0) - 1;
    if (n <= 0) this.counts.delete(deviceId);
    else this.counts.set(deviceId, n);
  }

  isOnline(deviceId: string): boolean {
    return (this.counts.get(deviceId) ?? 0) > 0;
  }
}
