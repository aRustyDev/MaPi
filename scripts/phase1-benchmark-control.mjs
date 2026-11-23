export async function verifyUserAudit(control, project, userId) {
  if (await control(project, 'user-audit', userId) !== 1) {
    throw new Error('Created user audit missing or duplicated');
  }
}
