/**
 * Tree trunks near the camera that you cannot walk through. The Foliage system refills this list as the
 * world around the camera is rebuilt; collision (worldData) reads it. `top` is the absolute height of
 * the tree, so a helicopter flying above the canopy is not blocked.
 */
export type TreeCollider = { x: number; z: number; r: number; top: number };
export const TREE_COLLIDERS: TreeCollider[] = [];
