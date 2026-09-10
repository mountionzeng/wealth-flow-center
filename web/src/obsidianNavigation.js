export const saveDraftBeforeNoteSelection = async ({ note, getCurrentNote, getDraft, save }) => {
  if (!note) return true;
  const draft = getDraft();
  if (draft === note.content) return true;

  const saved = await save(draft);
  if (!saved) return false;

  const currentNote = getCurrentNote?.() || note;
  return currentNote.path === saved.path && getDraft() === saved.content;
};
