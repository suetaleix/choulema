const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const SHARED_PROFILE = freeze({
  palette: [0x27bdd2, 0x9061da, 0xe76e9d, 0xe4a534, 0x33b68b, 0xe47b56],
  cards: {
    depth: .06, roughness: .36, metalness: .28, envMapIntensity: .50, bodyShade: .60,
    faceNeutral: 0xc3d0d2, faceMix: .65, faceHighlight: .08,
    edgeWidth: 8, topHighlightWidth: 4, textColor: 0x142630,
  },
  camera: {
    fov: 42, near: .1, far: 100, initialPosition: [0, 3.1, 9.4], initialAim: [0, 0, 0],
    portraitRatio: .8, portraitZ: 11.8, landscapeZ: 9.4,
    pitch: Math.atan2(3.1, 9.4), fitPadding: .08, idleFill: .86, surfaceFill: .70, resultFill: .90,
    maxSideOffset: .35, maxVerticalOffset: .18, maxPushDistance: .8, spinPushDistance: .45,
    pressOffset: .12, sphereLayoutRadius: 2.3,
  },
  rendering: {
    initialPixelRatio: 2, toneMappingExposure: 1.2,
    classicStage: { center: '#142b3e', mid: '#102438', edge: '#0b192a' },
    bloom: { width: 800, height: 800, strength: .28, radius: .6, threshold: .85 },
    qualityPixelRatio: { low: 1, medium: 1.25, high: 2, other: 1.6 },
  },
  timing: {
    automaticRunMs: 5200, returnMs: 620, secondsToMilliseconds: 1000,
    winnerFlightMs: 2000, returnFlightMs: 600, reducedFlightMs: 80,
    groupRevealDelayMs: 2350, groupRevealStartMs: 1800,
    groupStaggerMaxMs: 450, groupStaggerStepMaxMs: 80,
    celebrationLeadMs: 400,
  },
  effects: {
    maxParticles: 400,
    pointSizeByQuality: { low: 1.8, other: 2.4 },
    burstParticles: 80, ringCount: 3,
    themeColors: { classic: 0xaaff88, cosmic: 0xc5a0ff },
    machineColors: { capsule: 0xbce0cc, sphere: 0x96bbdb, wheel: 0xe3c58f, cosmicCapsule: 0xb6a1e8 },
    ringRadius: 2.7, ringRadiusStep: .3, ringTube: .013, ringTubeStep: .003,
    ringRotationX: Math.PI / 2, ringTiltStep: .32,
    glow: { classicEnergy: 1.2, cosmicEnergy: 1.55, classicBurst: 2, cosmicBurst: 2.35, position: [0, .8, 1.8] },
  },
});

export const MACHINE_PROFILES = freeze({
  capsule: {
    materials: {
      classic: { accent: 0xb7f57b, shell: 0x3b8578, glassRim: 0xbdeaff,
        glassOpacity: .075, glassRimOpacity: .42, glassRimTube: .014 },
      cosmic: {
        accent: 0x9d8be8, shell: 0x172746, glassRim: 0x91a6dc,
        shellMetalness: .32, shellRoughness: .3, shellClearcoat: .58, shellClearcoatRoughness: .24,
        structureColor: 0x7185b3, structureMetalness: .42, structureRoughness: .3,
        structureClearcoat: .32, structureIridescence: .32,
        accentMetalness: .28, accentRoughness: .31, accentClearcoat: .42,
        glassRimOpacity: .22,
        capsuleTint: 0x4b55b6, capsuleTintMix: .5, capsuleRoughness: .25,
        capsuleMetalness: .16, capsuleClearcoat: .42,
        capsuleEnvMapIntensity: .32, capsuleSpecularIntensity: .42,
        capsuleBottomColor: 0xa7afe4, capsuleBottomRoughness: .24,
        capsuleBottomMetalness: .06, capsuleBottomOpacity: .68,
        seamColor: 0xbcb9dc, seamMetalness: .24, seamRoughness: .4,
        claspColor: 0x9ca8d5, claspMetalness: .42, claspRoughness: .32,
        reveal: {
          seamArcColor: 0xd9d2ff, seamArcRadius: .265, seamArcTube: .005,
          seamArcLength: Math.PI * .38, seamArcPeakOpacity: .48,
          seamArcStarts: [.08, .23, .38], seamArcSpan: .42,
          cardClearcoat: .42, cardIridescence: .24,
          burstColor: 0xcbb7ff, burstSize: .08, burstDuration: .85,
          burstRadiusMin: .65, burstRadiusMax: .9,
        },
      },
      shellMetalness: .55, shellRoughness: .25,
      classicShellMetalness: .28, classicShellRoughness: .33,
      structureColor: 0x9cb3ac, structureMetalness: .65, structureRoughness: .28,
      glassColor: 0x75a7aa, glassOpacity: .04, glassRoughness: .14, glassMetalness: 0,
      glassEnvMapIntensity: .18, glassSpecularIntensity: .30,
      capsuleRoughness: .2, capsuleMetalness: .2, capsuleClearcoat: .65,
      capsuleBottomRoughness: .17, capsuleBottomMetalness: .08, capsuleBottomOpacity: .88,
      classicCapsuleRoughness: .27, classicCapsuleMetalness: .12, classicCapsuleClearcoat: .45,
      classicBottomColor: 0xb6cbd0, classicBottomRoughness: .25, classicBottomMetalness: .03, classicBottomOpacity: .60,
      seamColor: 0xb9c3b2, seamMetalness: .32, seamRoughness: .44, seamTubeRadius: .012,
      claspColor: 0xc0a568, claspSize: .055, claspMetalness: .65, claspRoughness: .28,
    },
    themes: {
      classic: { accent: 0xa3ff70, halo: 0xa3ff70 },
      cosmic: { accent: 0xa3ff70, halo: 0xa3ff70 },
    },
    camera: {
      scale: .95,
      singleResult: { target: [0, .65, 3], scale: 2.3, halfWidth: .45, halfHeight: .215, depthRadius: .26, openTop: .48, openBottom: .18 },
    },
    timing: {
      revealDelayMs: 4200, celebrationMs: 3400, flightMs: 3120,
      openDelayMs: 3300, openMs: 850, settleLift: .035,
      returnCloseMs: 220, returnTravelMs: 650, returnMs: 900,
    },
    effects: { bloomStrength: .24, cosmicBloomStrength: .34, classicRim: 0xb8ff83, cosmicRim: 0xa987ff },
  },
  sphere: {
    materials: {
      atlasRim: {
        inset: 5, width: 118, height: 70, radius: 8,
        lineWidth: 2, alpha: .72,
        colors: ['#83d8e8', '#b9a4e7', '#e6c69a'], stops: [0, .5, 1],
      },
      frontBrightnessFloor: .46, winnerOtherBrightness: .64,
    },
    themes: { classic: { accent: 0x8dcaff, halo: 0x8dcaff } },
    camera: {
      scale: .95,
      nameCard: { width: .95, height: .56 },
      sphereFill: .84,
      singleResult: { target: [0, .55, 2.8], scale: 2, flightArch: .48 },
    },
    timing: { revealFlightMs: 1400, revealDelayTailMs: 1400 },
    motion: {
      spinSpeed: 6.4, spinDamping: 5, idleSpeed: .12, resultSpeed: .025,
      idleDamping: 2.8, minCoastSeconds: 1.1, slowThreshold: 3, slowDuration: 1.4,
    },
    effects: { bloomStrength: .24 },
  },
  wheel: {
    materials: {
      sectorPalette: [0x36a995, 0xcb7290, 0xd8ad62, 0x5c96c7, 0x9981cc, 0x57adb8],
      sectorRoughness: .36, sectorMetalness: .18, sectorClearcoat: .4, sectorClearcoatRoughness: .36,
      sectorEnvMapIntensity: .4, sectorSpecularIntensity: .55,
      sectorEmissiveIntensity: .025, winnerEmissiveIntensity: .12,
      rimColor: 0xdcc49a, rimRoughness: .34, rimMetalness: .65, rimEnvMapIntensity: .5,
      supportColor: 0x344650, supportRoughness: .48, supportMetalness: .4,
      pinColor: 0xdcc49a, pinRoughness: .42,
      pointerColor: 0xfff0d5, pointerMetalness: .4, pointerRoughness: .3,
      labelBackground: '#182a32', labelText: '#f5f1e9',
    },
    themes: { classic: { accent: 0xa3ff70, halo: 0xa3ff70 } },
    camera: { scale: 1, diskFill: .84 },
    timing: {
      spinSpeed: 12, reducedSpinSpeed: 1.4, spinRate: 1.5,
      tickIntervalSeconds: .08, settleSeconds: .45, landingSecondsToMilliseconds: 1000,
    },
    effects: { bloomStrength: .24, trailCount: 28 },
    denseLabelThreshold: 13, denseLabelRadius: 2, denseLabelMaxSize: .38, denseLabelScale: 10.5,
  },
});
