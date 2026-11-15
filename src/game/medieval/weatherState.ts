/**
 * The weather of the world, shared by everything that reacts to it (sky, light, fog, rain, wind).
 * Every value eases smoothly between 0 and its target, so weather never switches abruptly.
 */
export const weather = {
  /** 0 = dry, 1 = heavy rain. */
  rain: 0,
  /** 0 = clear air, 1 = thick morning mist. */
  mist: 0,
  /** Multiplier for how hard the wind bends grass and leaves (1 = a gentle breeze). */
  wind: 1,
};
