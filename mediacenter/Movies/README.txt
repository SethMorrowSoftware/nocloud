Drop your movies in this folder. Both layouts work, and they can be mixed:

  Movies/
    Inception (2010).mkv                       a file straight in the folder
    The Iron Giant (1999)/                     ...or one folder per film
      The.Iron.Giant.1999.1080p.x264.mkv
      poster.jpg                               shown on the poster wall
      The.Iron.Giant.1999.1080p.x264.en.srt    subtitles, auto-detected

Nice to know:
  * A year in the name - "(2010)" or ".2010." - is picked up and shown.
  * Release-style names (dots, 1080p/BluRay/x264 tags) are cleaned up for display.
  * Posters: an image named poster/cover/folder, or one named like the movie file.
  * Subtitles: a .srt or .vtt next to the film (or in a Subs/ subfolder), named like
    the film; add a language tag like "Movie.en.srt" to label it.
  * Browsers play MP4 (H.264/AAC) and WebM everywhere; MKV usually plays in
    Chrome/Edge. Anything else still streams to VLC/mpv or downloads - the app
    offers both when the browser cannot decode a file.

This file is ignored by the media center; feel free to delete it.
