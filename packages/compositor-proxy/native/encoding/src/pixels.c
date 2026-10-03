#define GL_GLEXT_PROTOTYPES 1
#include <stdint.h>
#include <stdlib.h>
#include <stdbool.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GL/gl.h>
#include <GL/glext.h>
#include "westfield.h"
#include "westfield-egl.h"
#include "wlr_linux_dmabuf_v1.h"
#include "wlr_drm.h"
#include "pixels.h"

/*
 * Reads a rectangle of a client buffer as tightly packed RGBA rows (top to bottom), for lossless patches. SHM buffers
 * are read directly. dmabufs are imported as an EGLImage and read back through a framebuffer, using an EGL context of
 * our own: the session's EGL context is current on the GStreamer thread.
 */

static uint8_t *
read_shm_pixels(struct wl_shm_buffer *shm_buffer, int32_t x, int32_t y, int32_t width, int32_t height) {
    const uint32_t format = wl_shm_buffer_get_format(shm_buffer);
    // byte offsets of R, G, B, A in a little endian pixel, -1: no alpha
    int r, g, b, a;
    switch (format) {
        case WL_SHM_FORMAT_ARGB8888:
            r = 2, g = 1, b = 0, a = 3;
            break;
        case WL_SHM_FORMAT_XRGB8888:
            r = 2, g = 1, b = 0, a = -1;
            break;
        case WL_SHM_FORMAT_ABGR8888:
            r = 0, g = 1, b = 2, a = 3;
            break;
        case WL_SHM_FORMAT_XBGR8888:
            r = 0, g = 1, b = 2, a = -1;
            break;
        default:
            return NULL;
    }

    const int32_t stride = wl_shm_buffer_get_stride(shm_buffer);
    uint8_t *pixels = malloc((size_t) width * height * 4);
    if (pixels == NULL) {
        return NULL;
    }
    wl_shm_buffer_begin_access(shm_buffer);
    const uint8_t *data = wl_shm_buffer_get_data(shm_buffer);
    uint8_t *out = pixels;
    for (int32_t row = y; row < y + height; row++) {
        const uint8_t *in = data + (size_t) row * stride + (size_t) x * 4;
        for (int32_t column = 0; column < width; column++, in += 4, out += 4) {
            out[0] = in[r];
            out[1] = in[g];
            out[2] = in[b];
            out[3] = a < 0 ? 0xff : in[a];
        }
    }
    wl_shm_buffer_end_access(shm_buffer);
    return pixels;
}

static EGLContext readback_context = EGL_NO_CONTEXT;

static bool
make_readback_context_current(struct westfield_egl *westfield_egl) {
    EGLDisplay display = westfield_egl_get_display(westfield_egl);
    if (readback_context == EGL_NO_CONTEXT) {
        static const EGLint attribs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
        eglBindAPI(EGL_OPENGL_API);
        readback_context = eglCreateContext(display, westfield_egl_get_config(westfield_egl), EGL_NO_CONTEXT, attribs);
        if (readback_context == EGL_NO_CONTEXT) {
            return false;
        }
    }
    if (eglGetCurrentContext() == readback_context) {
        return true;
    }
    return eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, readback_context) == EGL_TRUE;
}

static uint8_t *
read_dmabuf_pixels(struct westfield_egl *westfield_egl, const struct dmabuf_attributes *attributes,
                   int32_t x, int32_t y, int32_t width, int32_t height) {
    static PFNGLEGLIMAGETARGETTEXTURE2DOESPROC image_target_texture_2d = NULL;
    if (westfield_egl == NULL || !make_readback_context_current(westfield_egl)) {
        return NULL;
    }
    if (image_target_texture_2d == NULL) {
        image_target_texture_2d = (PFNGLEGLIMAGETARGETTEXTURE2DOESPROC) eglGetProcAddress(
                "glEGLImageTargetTexture2DOES");
        if (image_target_texture_2d == NULL) {
            return NULL;
        }
    }

    bool external_only = false;
    EGLImageKHR image = westfield_egl_create_image_from_dmabuf(westfield_egl, attributes, &external_only);
    if (image == EGL_NO_IMAGE_KHR) {
        return NULL;
    }
    uint8_t *pixels = NULL;
    GLuint texture = 0, framebuffer = 0;
    if (external_only) {
        goto done;
    }

    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    image_target_texture_2d(GL_TEXTURE_2D, image);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        goto done;
    }

    pixels = malloc((size_t) width * height * 4);
    if (pixels == NULL) {
        goto done;
    }
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    // texture row 0 is the buffer's first (top) row, so no flip is needed
    glReadPixels(x, y, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    if (glGetError() != GL_NO_ERROR) {
        free(pixels);
        pixels = NULL;
    }

    done:
    if (framebuffer) {
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteFramebuffers(1, &framebuffer);
    }
    if (texture) {
        glDeleteTextures(1, &texture);
    }
    westfield_egl_destroy_image(westfield_egl, image);
    return pixels;
}

uint8_t *
read_buffer_pixels(struct wl_resource *buffer_resource, struct westfield_egl *westfield_egl,
                   int32_t x, int32_t y, int32_t width, int32_t height) {
    uint32_t buffer_width, buffer_height;
    const struct dmabuf_attributes *attributes = NULL;
    struct wl_shm_buffer *shm_buffer = NULL;

    if (wlr_dmabuf_v1_resource_is_buffer(buffer_resource)) {
        struct wlr_dmabuf_v1_buffer *dmabuf_v1_buffer = wlr_dmabuf_v1_buffer_from_buffer_resource(buffer_resource);
        buffer_width = dmabuf_v1_buffer->base.width;
        buffer_height = dmabuf_v1_buffer->base.height;
        attributes = &dmabuf_v1_buffer->attributes;
    } else if (wlr_drm_buffer_is_resource(buffer_resource)) {
        struct wlr_drm_buffer *drm_buffer = wlr_drm_buffer_from_resource(buffer_resource);
        buffer_width = drm_buffer->base.width;
        buffer_height = drm_buffer->base.height;
        attributes = &drm_buffer->dmabuf;
    } else if ((shm_buffer = wl_shm_buffer_get(buffer_resource)) != NULL) {
        buffer_width = wl_shm_buffer_get_width(shm_buffer);
        buffer_height = wl_shm_buffer_get_height(shm_buffer);
    } else {
        return NULL;
    }

    if (x < 0 || y < 0 || width <= 0 || height <= 0 ||
        (uint32_t) x + width > buffer_width || (uint32_t) y + height > buffer_height) {
        return NULL;
    }

    if (shm_buffer) {
        return read_shm_pixels(shm_buffer, x, y, width, height);
    }
    return read_dmabuf_pixels(westfield_egl, attributes, x, y, width, height);
}

bool
get_buffer_size(struct wl_resource *buffer_resource, uint32_t *width, uint32_t *height) {
    struct wl_shm_buffer *shm_buffer;
    if (wlr_dmabuf_v1_resource_is_buffer(buffer_resource)) {
        struct wlr_dmabuf_v1_buffer *dmabuf_v1_buffer = wlr_dmabuf_v1_buffer_from_buffer_resource(buffer_resource);
        *width = dmabuf_v1_buffer->base.width;
        *height = dmabuf_v1_buffer->base.height;
        return true;
    }
    if (wlr_drm_buffer_is_resource(buffer_resource)) {
        struct wlr_drm_buffer *drm_buffer = wlr_drm_buffer_from_resource(buffer_resource);
        *width = drm_buffer->base.width;
        *height = drm_buffer->base.height;
        return true;
    }
    if ((shm_buffer = wl_shm_buffer_get(buffer_resource)) != NULL) {
        *width = wl_shm_buffer_get_width(shm_buffer);
        *height = wl_shm_buffer_get_height(shm_buffer);
        return true;
    }
    return false;
}
