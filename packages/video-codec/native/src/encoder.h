/*
 * The GStreamer video encoder (gst_frame_encoder.c), run on its own GLib main loop thread (gst_main_loop.c). It encodes
 * frames (packages/frames, nebula_frame.h): the caller hands each encode one reference to the frame, and the encoder
 * releases it when GStreamer is done reading the buffer, on whichever GStreamer thread that is (the frame library takes
 * the release back to the frame's creating thread).
 */
#ifndef NEBULA_VIDEO_CODEC_ENCODER_H
#define NEBULA_VIDEO_CODEC_ENCODER_H

#include <stdbool.h>
#include <stdint.h>
#include "nebula_frame.h"

// encoder data interface, we don't know its contents
struct frame_encoder;

struct encoded_frame {
    void *encoded_data;
    uint32_t size;
};

/* On a GStreamer thread: an encoded frame (encoded_frame_finalize() frees it), or NULL if a frame couldn't be encoded. */
typedef void (*frame_callback_func)(void *user_data, struct encoded_frame *encoded_frame);

int
frame_encoder_create(char preferred_frame_encoder[16], frame_callback_func frame_ready_callback, void *user_data,
                     struct frame_encoder **frame_encoder_pp);

/* Encodes the frame, taking over the caller's reference to it. */
int
frame_encoder_encode(struct frame_encoder **frame_encoder_pp, struct nebula_frame *frame);

int
frame_encoder_request_key_unit(struct frame_encoder **frame_encoder_pp);

/* The quality of the frames from the next one on (a constant QP: higher, or lower while bandwidth is short). */
int
frame_encoder_set_quality(struct frame_encoder **frame_encoder_pp, bool high);

int
frame_encoder_destroy(struct frame_encoder **frame_encoder_pp);

int
encoded_frame_finalize(struct encoded_frame *encoded_frame);

#endif //NEBULA_VIDEO_CODEC_ENCODER_H
