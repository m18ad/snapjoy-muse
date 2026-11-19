// Used by the tunnels to move the player to the other end of a tunnel. The player's movement code
// picks up `pending` on its next frame.
export const teleportState: { pending: { x: number; z: number; yaw: number } | null } = { pending: null };
