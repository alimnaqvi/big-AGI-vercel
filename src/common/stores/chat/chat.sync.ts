import { useChatStore } from './store-chats';
import { apiAsyncNode } from '~/common/util/trpc.client';
import { DConversation } from './chat.conversation';

let isSyncing = false;
let syncEnabled = false;

// Debounced task queue
const uploadQueue = new Map<string, { conversation: DConversation; timeout: ReturnType<typeof setTimeout> }>();

export async function startCloudSync() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    syncEnabled = await apiAsyncNode.cloudSync.isEnabled.query();
    if (!syncEnabled) return;

    // 1. Fetch metadata from cloud
    const cloudChatsMeta = await apiAsyncNode.cloudSync.listChats.query();
    const cloudChatsMap = new Map(cloudChatsMeta.map(c => [c.conversationId, c.chatUpdatedMs]));

    // 2. Fetch local chats
    const localChats = useChatStore.getState().conversations;
    const localChatsMap = new Map(localChats.map(c => [c.id, c.updated]));

    const idsToDownload: string[] = [];
    const idsToUpload: DConversation[] = [];

    // 3. Compare and decide
    for (const cloudChat of cloudChatsMeta) {
      if (!cloudChat.chatUpdatedMs) continue;
      const localUpdated = localChatsMap.get(cloudChat.conversationId);
      if (!localUpdated) {
        // Cloud is newer or missing locally
        idsToDownload.push(cloudChat.conversationId);
      } else if (cloudChat.chatUpdatedMs > localUpdated) {
        idsToDownload.push(cloudChat.conversationId);
      }
    }

    for (const localChat of localChats) {
      if (!localChat.updated) continue;
      
      // Prevent syncing purely empty/novel chats
      if (!localChat.messages?.length && !localChat.userTitle && !localChat.autoTitle) continue;

      const cloudUpdated = cloudChatsMap.get(localChat.id);
      if (!cloudUpdated || localChat.updated > cloudUpdated) {
        // Local is newer or missing in cloud
        idsToUpload.push(localChat);
      }
    }

    // 4. Download
    if (idsToDownload.length > 0) {
      const { importConversation } = useChatStore.getState();
      
      // Batch downloads to avoid hitting the 5MB query limit 
      // (P6009 from Prisma when payload is too large)
      const batchSize = 10;
      for (let i = 0; i < idsToDownload.length; i += batchSize) {
        const batchIds = idsToDownload.slice(i, i + batchSize);
        try {
          const cloudChats = await apiAsyncNode.cloudSync.getChats.query({ conversationIds: batchIds });
          for (const cc of cloudChats) {
            if (cc.data) {
              importConversation(cc.data as unknown as DConversation, false);
            }
          }
        } catch (error) {
          console.error(`Cloud Sync Error downloading batch ${i}-${i + batchSize}`, error);
        }
      }
    }

    // 5. Upload
    for (const localChat of idsToUpload) {
      if (localChat._isIncognito) continue; // Don't upload incognito
      try {
        const sanitizedChat = JSON.parse(JSON.stringify(localChat).replace(/[\u0000]/g, ''));
        await apiAsyncNode.cloudSync.upsertChat.mutate({
          conversationId: localChat.id,
          data: sanitizedChat,
          chatUpdatedMs: localChat.updated || 0
        });
      } catch (error) {
        console.error('Cloud Sync Error uploading chat', localChat.id, error);
      }
    }

    subscribeToLocalChanges();
  } catch (error) {
    console.error('Cloud Sync Error during startup', error);
  } finally {
    isSyncing = false;
  }
}

function handleUpload(conversation: DConversation) {
  if (!syncEnabled || conversation._isIncognito) return;
  // Prevent syncing purely empty/novel chats via local updates
  if (!conversation.messages?.length && !conversation.userTitle && !conversation.autoTitle) return;
  
  if (uploadQueue.has(conversation.id)) {
    clearTimeout(uploadQueue.get(conversation.id)!.timeout);
  }

  const timeout = setTimeout(async () => {
    try {
      const sanitizedChat = JSON.parse(JSON.stringify(conversation).replace(/[\u0000]/g, ''));
      await apiAsyncNode.cloudSync.upsertChat.mutate({
        conversationId: conversation.id,
        data: sanitizedChat,
        chatUpdatedMs: conversation.updated || 0
      });
    } catch (e) {
      console.error('Cloud sync upload failed for', conversation.id, e);
    } finally {
      uploadQueue.delete(conversation.id);
    }
  }, 2000);

  uploadQueue.set(conversation.id, { conversation, timeout });
}

function handleDelete(conversationId: string) {
  if (!syncEnabled) return;
  
  if (uploadQueue.has(conversationId)) {
    clearTimeout(uploadQueue.get(conversationId)!.timeout);
    uploadQueue.delete(conversationId);
  }

  apiAsyncNode.cloudSync.deleteChat.mutate({ conversationId }).catch(e => {
    console.error('Cloud sync delete failed for', conversationId, e);
  });
}

function subscribeToLocalChanges() {
  useChatStore.subscribe((state, prevState) => {
    // Detect changes
    const prevMap = new Map(prevState.conversations.map(c => [c.id, c]));
    
    for (const current of state.conversations) {
      const prev = prevMap.get(current.id);
      if (!prev || prev.updated !== current.updated) {
        handleUpload(current);
      }
      prevMap.delete(current.id);
    }
    
    // Remaining in prevMap means deleted
    for (const deletedId of prevMap.keys()) {
      handleDelete(deletedId);
    }
  });
}
