import { AbsoluteFill, Audio, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const Scene = ({ title }: { title: string }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 14 } });
  const hue = interpolate(frame, [0, 90], [210, 320]);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 18%), #05060a)` }}>
      <Audio src={staticFile("tone.wav")} volume={(f) => interpolate(f, [0, 30], [0, 0.8], { extrapolateRight: "clamp" })} />
      <Sequence from={15} durationInFrames={60}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 480, height: 270, borderRadius: 24, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,.5)" }}>
            <OffthreadVideo src={staticFile("clip.mp4")} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        </AbsoluteFill>
      </Sequence>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 80,
          textAlign: "center",
          color: "white",
          fontFamily: "Helvetica, Arial, sans-serif",
          fontSize: 64,
          fontWeight: 800,
          transform: `translateY(${(1 - enter) * 60}px)`,
          opacity: enter,
        }}
      >
        {title}
      </div>
      <div style={{ position: "absolute", left: 80, bottom: 60, height: 10, borderRadius: 5, width: ((width - 160) * frame) / 89, background: "#6cf" }} />
    </AbsoluteFill>
  );
};

export const Card = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: "#111", color: "white", fontSize: 120, alignItems: "center", justifyContent: "center" }}>{frame}</AbsoluteFill>;
};
