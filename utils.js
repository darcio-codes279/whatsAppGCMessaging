async function findGroupByName(client, name) {
    const chats = await client.getChats();
    return chats.find(chat => chat.isGroup && chat.name === name);
}

async function isUserAdmin(client, group, userId) {
    try {
        // Get group participants
        const participants = await group.getParticipants();

        // Find the user in participants
        const user = participants.find(participant => participant.id._serialized === userId);

        // Check if user exists and has admin role
        return user && user.isAdmin;
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

module.exports = { findGroupByName, isUserAdmin };
