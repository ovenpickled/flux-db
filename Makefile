# Build everything -> make all
# Build only the server -> make server
# Build only avl tests -> make test_avl
# Build with sanitizers (for testing) -> make debug
# Build clean artifacts -> make clean

CXX = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -Wpedantic -O2 -g -Iinclude
SANFLAGS = -fsanitize=address,undefined

# Sources
SERVER_SRC = server.cpp hashtable.cpp avl.cpp zset.cpp heap.cpp thread_pool.cpp
CLIENT_SRC = client.cpp
TEST_AVL_SRC = tests/test_avl.cpp avl.cpp
TEST_OFFSET_SRC = tests/test_offset.cpp avl.cpp
TEST_HEAP_SRC = tests/test_heap.cpp heap.cpp

# Default target
all: server client test_avl test_offset test_heap

# Server
server: $(SERVER_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@ -lpthread

# Client
client: $(CLIENT_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@

# AVL tests
test_avl: $(TEST_AVL_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@

# Offset tests
test_offset: $(TEST_OFFSET_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@

# Heap tests
test_heap: $(TEST_HEAP_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@

# Debug build with sanitizers
debug: CXXFLAGS += $(SANFLAGS)
debug: clean all

# Clean
clean:
	rm -f server client test_avl test_offset test_heap
