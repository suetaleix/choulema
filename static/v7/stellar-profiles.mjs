// Approved cosmic materials, shared by all three machines.
import {SHARED_PROFILE as shared, MACHINE_PROFILES as machines} from '/v6/machine-profiles.mjs';
export const SHARED_PROFILE=structuredClone(shared);
export const MACHINE_PROFILES=structuredClone(machines);
const wheel=MACHINE_PROFILES.wheel;
Object.assign(wheel.materials,{sectorPalette:[0x233a63,0x30386c,0x263967,0x354173,0x263a68,0x303769,0x2a4368,0x344373],sectorRoughness:.2,sectorMetalness:.28,sectorClearcoat:.95,sectorClearcoatRoughness:.14,sectorEnvMapIntensity:.45,sectorSpecularIntensity:.55,sectorEmissiveIntensity:.035,winnerEmissiveIntensity:.15,rimColor:0x8d9fc4,rimMetalness:.65,rimRoughness:.22,rimEnvMapIntensity:.55,supportColor:0x142442,supportMetalness:.38,supportRoughness:.23,pinColor:0xcbbbee,pointerColor:0xcbdaf4,labelBackground:'rgba(10,8,30,0)',labelText:'#f4e9ff'});
wheel.effects.bloomStrength=.34;
MACHINE_PROFILES.sphere.effects.bloomStrength=.33;
MACHINE_PROFILES.sphere.materials.frontBrightnessFloor=.52;
MACHINE_PROFILES.capsule.effects.cosmicBloomStrength=.42;
MACHINE_PROFILES.capsule.materials.cosmic.shell=0x292844;
MACHINE_PROFILES.capsule.materials.cosmic.shellMetalness=.5;
MACHINE_PROFILES.capsule.materials.cosmic.shellRoughness=.24;
