import { AbsoluteFill } from "remotion";

// Flat patches: saturated red, green and blue show the RGB to YUV matrix an encoder used, dark grey
// its range (both ends of the primaries clip whatever the range).
export const Colors = () => (
  <AbsoluteFill style={{ flexDirection: "row" }}>
    {["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)", "rgb(40,40,40)"].map((color) => (
      <div key={color} style={{ width: 64, height: 64, background: color }} />
    ))}
  </AbsoluteFill>
);
