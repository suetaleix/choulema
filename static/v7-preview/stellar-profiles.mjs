// Preview-only materials. Production profiles and purchased entitlements are unchanged.
import {SHARED_PROFILE as shared, MACHINE_PROFILES as machines} from '/v6/machine-profiles.mjs';
export const SHARED_PROFILE=structuredClone(shared);
export const MACHINE_PROFILES=structuredClone(machines);
const wheel=MACHINE_PROFILES.wheel;
Object.assign(wheel.materials,{sectorPalette:[0x6650b7,0x3b739c,0xb073ba,0x4655a4,0x6f93aa,0x9062bc,0x497b9b,0x9a678d],sectorRoughness:.22,sectorMetalness:.42,sectorClearcoat:.95,sectorClearcoatRoughness:.18,sectorEnvMapIntensity:.62,sectorSpecularIntensity:.7,sectorEmissiveIntensity:.055,winnerEmissiveIntensity:.23,rimColor:0xbfb0e4,rimMetalness:.8,rimRoughness:.2,rimEnvMapIntensity:1,supportColor:0x1d1a3a,supportMetalness:.75,supportRoughness:.26,pinColor:0xcbbbee,pointerColor:0xe2d7ff,labelBackground:'rgba(10,8,30,0)',labelText:'#f4e9ff'});
wheel.effects.bloomStrength=.34;
MACHINE_PROFILES.sphere.effects.bloomStrength=.33;
MACHINE_PROFILES.sphere.materials.frontBrightnessFloor=.52;
MACHINE_PROFILES.capsule.effects.cosmicBloomStrength=.42;
MACHINE_PROFILES.capsule.materials.cosmic.shell=0x292844;
MACHINE_PROFILES.capsule.materials.cosmic.shellMetalness=.5;
MACHINE_PROFILES.capsule.materials.cosmic.shellRoughness=.24;
