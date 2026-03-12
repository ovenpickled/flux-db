#pragma once

#include <vector>
#include <string>

// lifecycle
void aof_open(const char *path);
void aof_flush();

// called after every mutating command
void aof_append(const std::vector<std::string> &cmd);

// called on startup for replaying the log
void aof_replay(void (*handler)(std::vector<std::string> &));
