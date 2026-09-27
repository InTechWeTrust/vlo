## How inpainting reads your inputs

Every inpainting workflow in vlo treats its inputs the same way, whichever
model is behind it.

- **Source video** is the timeline selection you give the workflow. It is the
  footage being edited.
- **The mask** is built for you from the masks on the clips in that selection.
  White areas are regenerated; everything else is kept from the source.
  Inpainting needs a mask, so add one to the clip before generating.

### Mask crop mode

![Crop mode generates only the masked box; full mode generates the whole frame](crop-vs-full.png)

- **Crop** (default) cuts the source and mask down to the mask's bounding box,
  plus some padding, before generating. The model spends all of its resolution
  on the area you are changing, which gives the most detail for small edits.
- **Full** generates the whole frame. Use it when the mask covers most of the
  frame, or when the edit depends on seeing the whole scene.

### Mask crop padding

Padding adds a margin of surrounding footage around the mask's box in crop
mode. More padding gives the model more context to blend the edit into the
scene; less padding keeps more resolution for the masked area itself.

### What comes back

The result is imported with the generation mask linked to it, so only the
masked area replaces the original footage.
