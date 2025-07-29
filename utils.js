async function findGroupByName(client, name) {
    const chats = await client.getChats();
    return chats.find(chat => chat.isGroup && chat.name === name);
}

async function isUserAdmin(client, group, userId) {
    try {
        console.log('Checking admin status for user:', userId);

        // Get group participants
        const participants = await group.getParticipants();
        console.log('Total participants:', participants.length);

        // Find the user in participants
        const user = participants.find(participant => {
            const participantId = participant.id._serialized;
            console.log('Comparing:', participantId, 'with', userId);
            return participantId === userId;
        });

        if (!user) {
            console.log('User not found in group participants');
            return false;
        }

        console.log('User found:', {
            id: user.id._serialized,
            isAdmin: user.isAdmin,
            isSuperAdmin: user.isSuperAdmin
        });

        // Check if user exists and has admin role (including super admin)
        return user && (user.isAdmin || user.isSuperAdmin);
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

module.exports = { findGroupByName, isUserAdmin };
