## Inpainting

**This workflow fills the gaps** — before, after or between clips, and the
holes that masks leave behind.

| Gap to fill | How to set it up on the timeline |
| --- | --- |
| **Masked area** | Mask the part of the clip you want replaced. |
| **Extend or prepend** | Leave empty space after (or before) the clip. |
| **Stitch** | Place the two clips with some space between them. |

### Step by step

1. **Prepare the timeline.** Mask any sections you want replaced, or place the
   clips you want to stitch with some space between them.
2. **Select the area to fill.** Click the main **load video** drop slot to open
   the timeline selection view, then select the area you want filled.

   > **Include some context.** When extending, prepending or stitching, the
   > selection must also take in a little of the existing footage before,
   > after, or on both sides of the empty space, so the model can see what it
   > is continuing.

3. **Describe the whole clip.** Write the prompt for the *entire* clip as you
   want it to look — including the parts you are **not** inpainting.

That's it — hit generate.

### Optional extras

| Workflow type | You can also add |
| --- | --- |
| Image-to-video (first/last frame) | Start and end frames |
| Reference-based | References |
