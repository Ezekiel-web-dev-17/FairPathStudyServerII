export const getArcjetMode = (): 'LIVE' | 'DRY_RUN' => {
  const mode = process.env.ARCJET_MODE?.trim().toUpperCase();
  return mode === 'LIVE' ? 'LIVE' : 'DRY_RUN';
};
