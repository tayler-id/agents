// The Docker names of a box: its container, and the volume that holds its home
// folder. The server gives them, and agentsctl's down removes them, by these names.
export const containerName = (instanceId: string) => `agents-box-${instanceId}`
export const homeVolumeName = (instanceId: string) => `${containerName(instanceId)}-home`
