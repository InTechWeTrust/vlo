import { useEffect, useState } from "react";

/** Native video fullscreen can bypass the surrounding editor DOM entirely. */
export function useMediaFullscreen(media: HTMLMediaElement | null): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!media) return;
    // Safari's native video player uses media events instead of the document
    // API, so it never populates `fullscreenElement`. A `fullscreenchange`
    // raised by some other element must not then read as Safari having exited.
    let webkitFullscreen = false;
    const update = () => {
      if (webkitFullscreen) return;
      setFullscreen(document.fullscreenElement === media);
    };
    const enterNativeFullscreen = () => {
      webkitFullscreen = true;
      setFullscreen(true);
    };
    const exitNativeFullscreen = () => {
      webkitFullscreen = false;
      setFullscreen(false);
    };
    update();
    document.addEventListener("fullscreenchange", update);
    media.addEventListener("webkitbeginfullscreen", enterNativeFullscreen);
    media.addEventListener("webkitendfullscreen", exitNativeFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      media.removeEventListener("webkitbeginfullscreen", enterNativeFullscreen);
      media.removeEventListener("webkitendfullscreen", exitNativeFullscreen);
    };
  }, [media]);
  // With no element mounted there is nothing to be fullscreen in, so the last
  // element's state is derived away rather than written back on teardown.
  return media !== null && fullscreen;
}
