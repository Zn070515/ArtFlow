import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { auroraFragment, auroraVertex } from "./shaders.js";

export function ShaderPlane() {
  const size = useThree((state) => state.size);
  const target = useRef(new THREE.Vector2(0.5, 0.55));
  const eased = useRef(new THREE.Vector2(0.5, 0.55));
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPointer: { value: new THREE.Vector2(0.5, 0.55) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uGold: { value: new THREE.Color("#E8B45A") },
      uEmber: { value: new THREE.Color("#C2410C") },
      uInk: { value: new THREE.Color("#07070A") },
    }),
    [],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      target.current.set(
        event.clientX / Math.max(window.innerWidth, 1),
        1 - event.clientY / Math.max(window.innerHeight, 1),
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame((_state, delta) => {
    if (document.visibilityState === "hidden") return;
    uniforms.uTime.value += Math.min(delta, 0.05);
    eased.current.lerp(target.current, 0.055);
    uniforms.uPointer.value.copy(eased.current);
    uniforms.uResolution.value.set(size.width, size.height);
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={auroraVertex}
        fragmentShader={auroraFragment}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}
