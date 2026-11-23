// Callback status belongs to the individual browser journey.
export function assertRpCallback(response) {
  if (response.status() !== 200) throw new Error('Independent RP callback failed');
}
