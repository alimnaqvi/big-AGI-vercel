import { useFolderStore } from './store-chat-folders';
import { apiAsyncNode } from '~/common/util/trpc.client';

let isSyncing = false;
let syncEnabled = false;

// Debounced task queue
let uploadTimeout: ReturnType<typeof setTimeout> | null = null;
let isDownloading = false;

export async function startFolderSync() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    syncEnabled = await apiAsyncNode.cloudSync.isEnabled.query();
    if (!syncEnabled) return;

    // 1. Fetch cloud folder data
    const cloudFolder = await apiAsyncNode.cloudSync.getFolders.query();
    const cloudUpdatedMs = cloudFolder?.updatedMs || 0;

    // 2. Fetch local folder data
    const localState = useFolderStore.getState();
    const localUpdatedMs = localState.updatedAt || 0;

    // 3. Compare and decide
    if (cloudUpdatedMs > localUpdatedMs && cloudFolder?.data) {
      // Cloud is newer or missing locally
      isDownloading = true;
      const { folders, enableFolders, updatedAt } = cloudFolder.data as any;
      useFolderStore.setState({ folders, enableFolders, updatedAt });
      isDownloading = false;
    } else if (localUpdatedMs > cloudUpdatedMs && localState.folders.length > 0) {
      // Local is newer or missing in cloud
      handleUpload();
    }

    subscribeToLocalChanges();
  } catch (error) {
    console.error('Cloud Sync Error during folder startup', error);
  } finally {
    isSyncing = false;
  }
}

function handleUpload() {
  if (!syncEnabled || isDownloading) return;
  
  if (uploadTimeout) {
    clearTimeout(uploadTimeout);
  }

  uploadTimeout = setTimeout(async () => {
    try {
      const state = useFolderStore.getState();
      const payload = {
        folders: state.folders,
        enableFolders: state.enableFolders,
        updatedAt: state.updatedAt || 0
      };
      
      const sanitizedPayload = JSON.parse(JSON.stringify(payload).replace(/[\u0000]/g, ''));
      await apiAsyncNode.cloudSync.upsertFolders.mutate({
        data: sanitizedPayload,
        updatedMs: state.updatedAt || 0
      });
    } catch (e) {
      console.error('Cloud sync folder upload failed', e);
    } finally {
      uploadTimeout = null;
    }
  }, 2000);
}

function subscribeToLocalChanges() {
  useFolderStore.subscribe((state, prevState) => {
    if (isDownloading) return;
    
    // Trigger upload if timestamp changed
    if (state.updatedAt !== prevState.updatedAt) {
      handleUpload();
    }
  });
}
