import { Canvas } from "@react-three/fiber";

import { ChromeRing } from "./ChromeRing.js";
import { DustField } from "./DustField.js";
import { ShaderPlane } from "./ShaderPlane.js";

export default function AuroraCanvas() {
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 5], fov: 45 }}
      onCreated={({ gl }) => gl.setClearColor("#07070A", 1)}
    >
      <ShaderPlane />
      <DustField />
      <ChromeRing />
    </Canvas>
  );
}
