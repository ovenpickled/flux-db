#include <stdio.h>
#include <assert.h>
#include <string.h>
#include <unistd.h>
#include "include/aof.h"

static FILE *aof_fp = NULL;
static bool aof_replaying = false;

void aof_open(const char *path) {
  // 'a' is append mode, creates file if it doesn't exist
  aof_fp = fopen(path, "a");
  assert(aof_fp);
}

void aof_append(const std::vector<std::string> &cmd) {
  if (aof_replaying) return;
  assert(aof_fp);
  // write each argument space-separated, newline at the end
  for (size_t i = 0; i < cmd.size(); ++i) {
    if (i > 0) {
      fputc(' ', aof_fp);
    }
    // escape spaces inside arguments with quotes
    bool has_space = cmd[i].find(' ') != std::string::npos;
    if (has_space) {
      fputc('"', aof_fp);
      fputs(cmd[i].c_str(), aof_fp);
      fputc('"', aof_fp);
      } else {
        fputs(cmd[i].c_str(), aof_fp);
      }
    }
    fputc('\n', aof_fp);
}

void aof_flush() {
  assert(aof_fp);
  fflush(aof_fp);              // fflush moves data from stdio buffer to kernel
  fsync(fileno(aof_fp));       // fsync moves data from kernel buffer to disk
}

void aof_replay(void (*handler)(std::vector<std::string> &)) {
  // open for reading only during replay
  aof_replaying = true;
  FILE *fp = fopen("aof.log", "r");
  if (!fp) {
    return;             // no AOF file yet, fresh start
  }

  char line[65536];         // max line length
  while (fgets(line, sizeof(line), fp)) {
    // strip the trailing newline
    size_t len = strlen(line);
    if (len > 0 && line[len - 1] == '\n') {
      line[len - 1] = '\0';
      len--;
    }
    if (len == 0) {
      continue;            // skip empty lines
    }
    // parse the line into tokens (will handle quoted args)
    std::vector<std::string> cmd;
    char *p = line;
    while (*p) {
      // skip leading spaces
      while (*p == ' ') p++;
      if (!*p) break;
      if (*p == '"') {
        // quoted argument
        p++;
        char *start = p;
        while (*p && *p != '"') p++;
        cmd.push_back(std::string(start, p));
        if (*p == '"') p++;
        } else {
          // unquoted argument
          char *start = p;
          while (*p && *p != ' ') p++;
          cmd.push_back(std::string(start, p));
          }
    }
    if (!cmd.empty()) {
      handler(cmd);
    }
  }
  fclose(fp);
  aof_replaying = false;
}
