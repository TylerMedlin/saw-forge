// Which parameter set an instrument uses: Saw Forge, Worship Atmospheres or the EDM drum kit.
import { SYNTH_PARAMS, SYNTH_INDEX, SYNTH_DEF } from './params.js';
import { WORSHIP_PARAMS, WP_INDEX, WP_DEF } from './worship-params.js';
import { DRUM_PARAMS, DRUM_INDEX, DRUM_DEF } from './drums.js';

const SETS = {
  sawforge: { PARAMS: SYNTH_PARAMS, INDEX: SYNTH_INDEX, DEF: SYNTH_DEF, label: 'Saw Forge' },
  worship: { PARAMS: WORSHIP_PARAMS, INDEX: WP_INDEX, DEF: WP_DEF, label: 'Worship Atmospheres' },
  drums: { PARAMS: DRUM_PARAMS, INDEX: DRUM_INDEX, DEF: DRUM_DEF, label: 'EDM Drum Kit' },
};
export const instType = (inst) => (inst && SETS[inst.type] ? inst.type : 'sawforge');
export const instDefs = (instOrType) => SETS[typeof instOrType === 'string' ? (SETS[instOrType] ? instOrType : 'sawforge') : instType(instOrType)];
