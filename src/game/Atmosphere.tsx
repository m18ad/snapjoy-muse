import { useCallback, useState } from "react";
import { Particles } from "./fx/Particles";
import { CloudShadows, Birds } from "./fx/Life";
import { SkyIslands } from "./SkyIslands";
import { AdaptiveQuality, PerfOverlay } from "./PerfTools";
import { pushAlert } from "./alertState";
import { Weather } from "./medieval/Weather";

// The sky itself (blue gradient, clouds, sun) lives in medieval/SkyDome, mounted by the City.
// Weather (rain, mist, wind) is medieval/Weather. The old purple mountains, the wasteland beyond the
// map, the cloud banks, the world border and the kingdom clouds are gone.
// Heavy extras are switched off automatically on a phone that struggles (or with ?lowfx=1).
const FORCE_LOW = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("lowfx");

export function Atmosphere() {
  const [low, setLow] = useState(FORCE_LOW);

  const onLow = useCallback(() => {
    setLow((was) => {
      if (!was) pushAlert("Graphics lowered to keep the game smooth.", "warn");
      return true;
    });
  }, []);

  return (
    <>
      <PerfOverlay />
      <AdaptiveQuality onLow={onLow} />

      <SkyIslands />
      {/* The weather cycle runs even on low graphics (it is cheap); the rain streaks are the only cost. */}
      <Weather />

      {!low && (
        <>
          <Particles />
          <CloudShadows />
          <Birds />
        </>
      )}
    </>
  );
}
