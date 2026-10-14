// What a box's container and home volume are called, and the label that marks a
// box's container with its instance. The server starts boxes by these names, and
// the cutover export and restore find boxes' home folders by them.

export const BOX_LABEL = 'agents.instance'
export const boxContainer = (instanceId: string) => `agents-box-${instanceId}`
export const boxHomeVolume = (instanceId: string) => `${boxContainer(instanceId)}-home`
