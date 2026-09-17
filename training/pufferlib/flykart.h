#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef float obs_t;
#include "pufferenv.h"

#define ACT_SIZES {5}
#define OBS_SIZE 9
#define NUM_ATNS 1

#define FK_LEFT 0
#define FK_ACCEL 1
#define FK_RIGHT 2
#define FK_REVERSE 3
#define FK_BRAKE 4
#define FK_TRACKS 3
#define FK_MAX_POINTS 14
#define FK_PI 3.14159265358979323846f
#define FK_TAU (2.0f * FK_PI)
#define FK_STEP (1.0f / 30.0f)

typedef struct { float x; float y; } FkVec;
typedef struct { FkVec point; FkVec tangent; float distance; float progress; } FkNearest;

static const FkVec FK_POINTS[FK_TRACKS][FK_MAX_POINTS] = {
    {
        {-310, -100}, {-205, -165}, {-30, -185}, {170, -155}, {305, -65},
        {315, 70}, {195, 155}, {5, 180}, {-190, 145}, {-315, 50},
        {0, 0}, {0, 0}, {0, 0}, {0, 0}
    },
    {
        {-325, -120}, {-205, -185}, {45, -185}, {300, -120}, {330, -20},
        {90, 20}, {-160, 30}, {-285, 105}, {-130, 180}, {135, 175},
        {320, 105}, {275, 20}, {30, -20}, {-220, -35}
    },
    {
        {-325, -80}, {-245, -175}, {-40, -135}, {100, -205}, {290, -135},
        {325, -10}, {180, 55}, {300, 150}, {115, 190}, {-65, 125},
        {-210, 190}, {-330, 95}, {0, 0}, {0, 0}
    }
};
static const int FK_POINT_COUNTS[FK_TRACKS] = {10, 14, 12};

struct Log {
    float perf;
    float score;
    float episode_return;
    float episode_length;
    float finished;
    float crashed;
    float n;
};

typedef struct Client {
    int width;
    int height;
} Client;

struct Env {
    Log log;
    Agent agents[1];
    Client* client;
    int tag;
    int boundary_reached;
    int num_agents;
    unsigned int rng;

    int track_set;
    int track_id;
    int track_width;
    int max_ticks;
    int frameskip;
    int tick;
    float lookahead;
    float max_speed;
    float reverse_speed;
    float steer_rate;
    float progress_per_second;
    float direction_per_second;
    float movement_per_second;
    float standing_per_second;
    float wrong_direction_per_second;
    float reverse_progress_per_second;
    float off_track_per_second;
    float centerline_per_second;
    float collision_penalty;
    float crash_penalty;
    float finish_reward;

    FkVec position;
    float heading;
    float speed;
    float progress;
    float distance_along;
    float total_progress;
    float lateral_offset;
    float episode_return;
    int finished;
    int crashed;
};
typedef Env FlyKart;

static inline float fk_clamp(float value, float low, float high) {
    return fmaxf(low, fminf(high, value));
}

static inline FkVec fk_add(FkVec a, FkVec b) { return (FkVec){a.x + b.x, a.y + b.y}; }
static inline FkVec fk_sub(FkVec a, FkVec b) { return (FkVec){a.x - b.x, a.y - b.y}; }
static inline FkVec fk_scale(FkVec a, float value) { return (FkVec){a.x * value, a.y * value}; }
static inline float fk_dot(FkVec a, FkVec b) { return a.x * b.x + a.y * b.y; }
static inline float fk_cross(FkVec a, FkVec b) { return a.x * b.y - a.y * b.x; }
static inline float fk_length(FkVec a) { return sqrtf(a.x * a.x + a.y * a.y); }
static inline FkVec fk_normalize(FkVec a) {
    float length = fk_length(a);
    return length > 1e-6f ? fk_scale(a, 1.0f / length) : (FkVec){1.0f, 0.0f};
}
static inline float fk_wrap(float angle) { return atan2f(sinf(angle), cosf(angle)); }

static inline FkVec fk_point(int track_id, int index) {
    int count = FK_POINT_COUNTS[track_id];
    return FK_POINTS[track_id][(index + count) % count];
}

static float fk_track_length(int track_id) {
    float length = 0.0f;
    int count = FK_POINT_COUNTS[track_id];
    for (int index = 0; index < count; index++) length += fk_length(fk_sub(fk_point(track_id, index + 1), fk_point(track_id, index)));
    return length;
}

static void fk_nearest(FlyKart* env, FkVec position, FkNearest* result) {
    float best_distance = 1e30f;
    float length = fk_track_length(env->track_id);
    float distance_along = 0.0f;
    int count = FK_POINT_COUNTS[env->track_id];
    for (int index = 0; index < count; index++) {
        FkVec a = fk_point(env->track_id, index); FkVec b = fk_point(env->track_id, index + 1); FkVec segment = fk_sub(b, a);
        float segment_length_sq = fmaxf(1.0f, fk_dot(segment, segment));
        float t = fk_clamp(fk_dot(fk_sub(position, a), segment) / segment_length_sq, 0.0f, 1.0f);
        FkVec point = fk_add(a, fk_scale(segment, t)); FkVec offset = fk_sub(position, point); float distance = fk_length(offset);
        if (distance < best_distance) {
            best_distance = distance;
            result->point = point;
            result->tangent = fk_normalize(segment);
            result->distance = distance;
            result->progress = distance_along / fmaxf(1.0f, length);
        }
        distance_along += sqrtf(segment_length_sq);
    }
}

static void fk_point_at(FlyKart* env, float requested_distance, FkVec* point, FkVec* tangent) {
    float length = fk_track_length(env->track_id);
    float distance = fmodf(fmaxf(0.0f, requested_distance), fmaxf(1.0f, length));
    float travelled = 0.0f;
    int count = FK_POINT_COUNTS[env->track_id];
    for (int index = 0; index < count; index++) {
        FkVec a = fk_point(env->track_id, index); FkVec b = fk_point(env->track_id, index + 1); FkVec segment = fk_sub(b, a);
        float segment_length = fk_length(segment);
        if (distance <= travelled + segment_length || index == count - 1) {
            float t = fk_clamp((distance - travelled) / fmaxf(1.0f, segment_length), 0.0f, 1.0f);
            *point = fk_add(a, fk_scale(segment, t)); *tangent = fk_normalize(segment); return;
        }
        travelled += segment_length;
    }
    *point = fk_point(env->track_id, 0); *tangent = fk_normalize(fk_sub(fk_point(env->track_id, 1), *point));
}

static float fk_lateral(FkVec position, FkNearest nearest, int track_width) {
    return fk_clamp(fk_cross(nearest.tangent, fk_sub(position, nearest.point)) / fmaxf(1.0f, track_width * 0.5f), -1.5f, 1.5f);
}

static void fk_observations(FlyKart* env) {
    FkNearest nearest; FkVec lookahead, lookahead_tangent; fk_nearest(env, env->position, &nearest);
    fk_point_at(env, nearest.progress * fk_track_length(env->track_id) + env->lookahead, &lookahead, &lookahead_tangent);
    float desired = atan2f(lookahead.y - env->position.y, lookahead.x - env->position.x);
    float heading_error = fk_wrap(desired - env->heading) / FK_PI;
    float curvature = fk_wrap(atan2f(lookahead_tangent.y, lookahead_tangent.x) - env->heading) / FK_PI;
    env->lateral_offset = fk_lateral(env->position, nearest, env->track_width);
    float* obs = env->agents[0].observations;
    obs[0] = fk_clamp(heading_error, -1.0f, 1.0f);
    obs[1] = fk_clamp(curvature, -1.0f, 1.0f);
    obs[2] = fk_clamp(env->lateral_offset, -1.0f, 1.0f);
    obs[3] = fk_clamp(env->speed / fmaxf(1.0f, env->max_speed), -1.0f, 1.0f);
    obs[4] = fk_clamp(1.0f - fabsf(env->lateral_offset), -1.0f, 1.0f);
    obs[5] = 0.0f;
    obs[6] = 0.0f;
    obs[7] = sinf((float)env->tick * 0.025f);
    obs[8] = 1.0f;
}

static void fk_add_log(FlyKart* env) {
    float length = fk_track_length(env->track_id);
    env->log.episode_length += (float)env->tick;
    env->log.episode_return += env->episode_return;
    env->log.score += env->episode_return;
    env->log.perf += env->total_progress / fmaxf(1.0f, length) + (env->finished ? 1.0f : 0.0f);
    env->log.finished += env->finished ? 1.0f : 0.0f;
    env->log.crashed += env->crashed ? 1.0f : 0.0f;
    env->log.n += 1.0f;
}

void puf_close(FlyKart* env) {
    if (env->client) {
        if (IsWindowReady()) CloseWindow();
        free(env->client); env->client = NULL;
    }
}

void puf_render(FlyKart* env) {
    if (!env->client) {
        env->client = (Client*)calloc(1, sizeof(Client)); env->client->width = 960; env->client->height = 600;
        InitWindow(env->client->width, env->client->height, "FlyKart · PufferLib"); SetTargetFPS(60);
    }
    if (IsKeyPressed(KEY_ESCAPE)) exit(0);
    BeginDrawing(); ClearBackground((Color){12, 21, 24, 255});
    float scale = 0.82f, ox = 480.0f, oy = 300.0f; int count = FK_POINT_COUNTS[env->track_id];
    for (int index = 0; index < count; index++) {
        FkVec a = fk_point(env->track_id, index), b = fk_point(env->track_id, index + 1);
        Vector2 va = {ox + a.x * scale, oy + a.y * scale}, vb = {ox + b.x * scale, oy + b.y * scale};
        DrawLineEx(va, vb, (float)(env->track_width + 14) * scale, (Color){52, 69, 75, 255});
        DrawLineEx(va, vb, (float)env->track_width * scale, (Color){24, 39, 43, 255});
        DrawLineEx(va, vb, 2.0f, (Color){123, 150, 139, 255});
    }
    Vector2 car = {ox + env->position.x * scale, oy + env->position.y * scale};
    DrawCircleV(car, 9.0f, (Color){116, 192, 255, 255});
    Vector2 nose = {car.x + cosf(env->heading) * 16.0f, car.y + sinf(env->heading) * 16.0f};
    DrawLineEx(car, nose, 3.0f, (Color){231, 244, 255, 255});
    DrawText("FlyKart + PufferLib", 18, 18, 22, (Color){231, 244, 255, 255});
    DrawText(TextFormat("track %d · tick %d · score %.1f", env->track_id, env->tick, env->episode_return), 18, 48, 18, (Color){164, 184, 198, 255});
    EndDrawing(); puf_web_vsync();
}

void puf_reset(FlyKart* env) {
    if (env->track_set >= FK_TRACKS) env->track_id = (int)(rand_r(&env->rng) % FK_TRACKS);
    else env->track_id = (int)fk_clamp((float)env->track_set, 0.0f, (float)(FK_TRACKS - 1));
    FkVec start = fk_point(env->track_id, 0); FkVec next = fk_point(env->track_id, 1);
    env->position = start; env->heading = atan2f(next.y - start.y, next.x - start.x); env->speed = 0.0f;
    env->progress = 0.0f; env->distance_along = 0.0f; env->total_progress = 0.0f; env->lateral_offset = 0.0f;
    env->episode_return = 0.0f; env->finished = 0; env->crashed = 0; env->tick = 0;
    fk_observations(env);
}

static float fk_frame(FlyKart* env, int action) {
    float steer = action == FK_LEFT ? -1.0f : action == FK_RIGHT ? 1.0f : 0.0f;
    float reverse = action == FK_REVERSE ? 1.0f : 0.0f; float brake = action == FK_BRAKE ? 1.0f : 0.0f;
    FkNearest before; fk_nearest(env, env->position, &before); int was_off_track = before.distance > env->track_width * 0.5f;
    float grip = was_off_track ? 0.35f : 1.0f; float steering_direction = env->speed < -0.5f ? -1.0f : 1.0f;
    env->heading += steer * (env->steer_rate + fabsf(env->speed) / 150.0f) * grip * steering_direction * FK_STEP;
    float acceleration = 55.0f - reverse * 45.0f - env->speed * 0.23f;
    if (env->speed > 0.0f) acceleration -= brake * 75.0f; else if (env->speed < 0.0f) acceleration += brake * 75.0f;
    env->speed = fk_clamp(env->speed + acceleration * FK_STEP, -env->reverse_speed, env->max_speed);
    env->position.x += cosf(env->heading) * env->speed * FK_STEP; env->position.y += sinf(env->heading) * env->speed * FK_STEP;

    FkNearest nearest; fk_nearest(env, env->position, &nearest); int off_track = nearest.distance > env->track_width * 0.5f;
    if (off_track) {
        FkVec offset = fk_sub(env->position, nearest.point); float distance = fk_length(offset);
        float safe_distance = env->track_width * 0.5f - 14.0f * 0.65f;
        float pull = fk_clamp((distance - safe_distance) * (distance > env->track_width * 1.25f ? 0.5f : 0.2f), 1.5f, 18.0f);
        env->position = fk_sub(env->position, fk_scale(fk_normalize(offset), pull));
        if (distance > env->track_width * 1.25f) env->speed *= 0.55f;
        fk_nearest(env, env->position, &nearest);
    }

    float raw_delta = nearest.progress - env->progress; float local_delta = raw_delta;
    if (local_delta < -0.5f) local_delta += 1.0f; else if (local_delta > 0.5f) local_delta -= 1.0f;
    FkVec forward = {cosf(env->heading), sinf(env->heading)}; float alignment = fk_dot(forward, nearest.tangent);
    int lap_crossed = raw_delta < -0.5f && alignment > 0.15f && env->speed > 2.0f;
    int first_finish = lap_crossed && !env->finished; if (lap_crossed) env->finished = 1;
    float continuous_delta = local_delta + (lap_crossed ? 1.0f : 0.0f);
    float valid_delta = continuous_delta > 0.0f && alignment > -0.35f ? continuous_delta : 0.0f;
    env->total_progress += valid_delta; env->progress = nearest.progress; env->distance_along = nearest.progress * fk_track_length(env->track_id);
    env->lateral_offset = fk_lateral(env->position, nearest, env->track_width); env->tick += 1;
    if (env->tick >= env->max_ticks) env->crashed = 1;

    float reward = (valid_delta / FK_STEP) * env->progress_per_second;
    reward += fmaxf(0.0f, alignment) * env->direction_per_second * FK_STEP;
    reward += (!off_track ? fk_clamp(fabsf(env->speed) / 60.0f, 0.0f, 1.0f) * env->movement_per_second * FK_STEP : 0.0f);
    if (fabsf(env->speed) < 3.0f) reward -= env->standing_per_second * FK_STEP;
    reward -= fmaxf(0.0f, -alignment) * env->wrong_direction_per_second * FK_STEP;
    reward -= fmaxf(0.0f, -local_delta) / FK_STEP * env->reverse_progress_per_second;
    if (off_track || was_off_track) reward -= env->off_track_per_second * FK_STEP;
    reward += fmaxf(0.0f, 1.0f - fabsf(env->lateral_offset)) * env->centerline_per_second * FK_STEP;
    if (first_finish) reward += env->finish_reward;
    if (env->crashed) reward -= env->crash_penalty;
    env->episode_return += reward;
    return reward;
}

void puf_step(FlyKart* env) {
    env->agents[0].terminals[0] = 0.0f; env->agents[0].rewards[0] = 0.0f;
    int action = (int)fk_clamp(env->agents[0].actions[0], 0.0f, 4.0f); float reward = 0.0f; int done = 0;
    for (int frame = 0; frame < env->frameskip; frame++) {
        reward += fk_frame(env, action);
        if (env->finished || env->crashed) { done = 1; break; }
    }
    env->agents[0].rewards[0] = reward; env->agents[0].terminals[0] = done ? 1.0f : 0.0f;
    if (done) { fk_add_log(env); puf_reset(env); }
    fk_observations(env);
}

void puf_log(Log* log, Dict* out) {
    dict_set(out, "perf", log->perf); dict_set(out, "score", log->score); dict_set(out, "episode_return", log->episode_return);
    dict_set(out, "episode_length", log->episode_length); dict_set(out, "finished", log->finished); dict_set(out, "crashed", log->crashed); dict_set(out, "n", log->n);
}

void puf_init(Env* env, Dict* kwargs) {
    env->num_agents = 1; env->client = NULL; env->rng = 1;
    env->track_set = dict_get(kwargs, "track_set"); env->track_width = dict_get(kwargs, "track_width"); env->max_ticks = dict_get(kwargs, "max_ticks");
    env->frameskip = dict_get(kwargs, "frameskip"); env->lookahead = dict_get(kwargs, "lookahead"); env->max_speed = dict_get(kwargs, "max_speed"); env->reverse_speed = dict_get(kwargs, "reverse_speed"); env->steer_rate = dict_get(kwargs, "steer_rate");
    env->progress_per_second = dict_get(kwargs, "progress_per_second"); env->direction_per_second = dict_get(kwargs, "direction_per_second"); env->movement_per_second = dict_get(kwargs, "movement_per_second");
    env->standing_per_second = dict_get(kwargs, "standing_per_second"); env->wrong_direction_per_second = dict_get(kwargs, "wrong_direction_per_second"); env->reverse_progress_per_second = dict_get(kwargs, "reverse_progress_per_second");
    env->off_track_per_second = dict_get(kwargs, "off_track_per_second"); env->centerline_per_second = dict_get(kwargs, "centerline_per_second"); env->collision_penalty = dict_get(kwargs, "collision_penalty");
    env->crash_penalty = dict_get(kwargs, "crash_penalty"); env->finish_reward = dict_get(kwargs, "finish_reward"); env->agents[0].action_mask = NULL; env->agents[0].policy = 0;
    memset(&env->log, 0, sizeof(env->log));
}
