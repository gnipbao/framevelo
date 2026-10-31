import { AbsoluteFill } from "remotion";

// Flat red, green, blue and gray patches: shows which RGB to YUV matrix an encoder used.
export const Colors = () => (
  <AbsoluteFill style={{ flexDirection: "row" }}>
    {["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)", "rgb(128,128,128)"].map((color) => (
      <div key={color} style={{ width: 64, height: 64, background: color }} />
    ))}
  </AbsoluteFill>
);
