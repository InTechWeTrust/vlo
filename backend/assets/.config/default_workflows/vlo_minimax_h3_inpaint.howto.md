# MiniMax H3 Inpaint (Reference)

Replaces a masked region of a video clip using MiniMax H3, optionally guided by
reference images, videos and audio.

1. Mask the area you want to change on the clip.
2. Select that part of the timeline as the **Source video**.
3. Optionally add references under **References**.
4. Describe what should appear in the masked area in the prompt, then generate.

## Referring to references in the prompt

References are numbered in the order they are attached. Refer to them in the
prompt by tag, for example `<Picture 1>` or `<Video 2>`. The tag is matched by
position, so reordering references changes which one each tag means.

::include{src="shared:inpainting/mask-inputs.md"}
