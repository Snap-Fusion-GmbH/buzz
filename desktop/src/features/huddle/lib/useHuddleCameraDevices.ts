import * as React from "react";
import { type CameraDevice, listHuddleCameras } from "./huddleCamera";

/** Demand-driven discovery avoids WebKit's enumeration/devicechange feedback loop. */
export function useHuddleCameraDevices(channelId: string | null) {
  const [cameras, setCameras] = React.useState<CameraDevice[]>([]);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scope = React.useRef(channelId);
  scope.current = channelId;
  const mounted = React.useRef(false);
  const generation = React.useRef(0);
  const pending = React.useRef<Promise<CameraDevice[]> | null>(null);

  const refresh = React.useCallback(async () => {
    const channel = scope.current;
    if (!mounted.current || !channel) return;
    const request = ++generation.current;
    const current = () =>
      mounted.current &&
      scope.current === channel &&
      generation.current === request;
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) {
      setCameras([]);
      setChecking(false);
      return;
    }
    setChecking(true);
    const probe = pending.current ?? listHuddleCameras(devices);
    pending.current = probe;
    try {
      const found = await probe;
      if (current()) {
        setCameras((previous) =>
          previous.length === found.length &&
          previous.every(
            (camera, index) =>
              camera.deviceId === found[index].deviceId &&
              camera.label === found[index].label,
          )
            ? previous
            : found,
        );
        setError(null);
      }
    } catch (failure) {
      if (current()) setError(`Could not list cameras: ${String(failure)}`);
    } finally {
      if (pending.current === probe) pending.current = null;
      if (current()) setChecking(false);
    }
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    if (channelId) {
      void refresh();
    } else {
      generation.current++;
      setCameras([]);
      setChecking(false);
      setError(null);
    }
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [channelId, refresh]);

  return { cameras, checking, error, refresh };
}
