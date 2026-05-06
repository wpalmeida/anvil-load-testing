export type Stage = { duration: string; target: number };
export type Profile = 'smoke' | 'load' | 'stress' | 'spike' | 'soak' | 'custom';
export type ProfileKind = 'constant' | 'ramping';

export type ProfileDefaults = {
  kind: ProfileKind;
  vus?: number;
  duration?: string;
  startVUs?: number;
  stages?: Stage[];
  description: string;
  editable: { vus: boolean; duration: boolean; stages: boolean };
};

export const PROFILE_DEFAULTS: Record<Profile, ProfileDefaults> = {
  smoke: {
    kind: 'constant',
    vus: 1,
    duration: '30s',
    description: 'Sanity check — 1 VU, 30s. Verifies the script works.',
    editable: { vus: false, duration: false, stages: false },
  },
  load: {
    kind: 'constant',
    vus: 10,
    duration: '5m',
    description: 'Steady traffic at expected production volume.',
    editable: { vus: true, duration: true, stages: false },
  },
  stress: {
    kind: 'ramping',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 50 },
      { duration: '5m', target: 50 },
      { duration: '2m', target: 100 },
      { duration: '5m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '5m', target: 200 },
      { duration: '2m', target: 0 },
    ],
    description: 'Ramps past expected load to find the breaking point.',
    editable: { vus: false, duration: false, stages: true },
  },
  spike: {
    kind: 'ramping',
    startVUs: 0,
    stages: [
      { duration: '10s', target: 50 },
      { duration: '1m', target: 50 },
      { duration: '10s', target: 500 },
      { duration: '3m', target: 500 },
      { duration: '10s', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '10s', target: 0 },
    ],
    description: 'Sudden burst to a peak, then drops back. Tests recovery.',
    editable: { vus: false, duration: false, stages: true },
  },
  soak: {
    kind: 'constant',
    vus: 50,
    duration: '30m',
    description: 'Sustained moderate load over long duration. Finds leaks.',
    editable: { vus: true, duration: true, stages: false },
  },
  custom: {
    kind: 'ramping',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '1m', target: 10 },
      { duration: '30s', target: 0 },
    ],
    description: 'Define your own ramping stages from scratch.',
    editable: { vus: false, duration: false, stages: true },
  },
};
