// Shared riding state. Written by the horses (mount / dismount) and read by the player
// movement, the camera and the character body.
export const mountState = {
  mounted: false,
  /** Moves the player faster while riding. */
  speedMult: 1,
  /** How far the rider is lifted above the ground so they sit on the horse's back. */
  lift: 0,
  /** Extra camera height and distance so the rider and horse both fit on screen. */
  camUp: 0,
  camBack: 0,
  /** Which way the player's body faces (written by the character body each frame). */
  yaw: 0,
};
