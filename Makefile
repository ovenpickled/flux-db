# Build everything -> make all
# Build only the server -> make server
# Build only avl tests -> make test_avl
# Build with sanitizers (for testing) -> make debug
# Build clean artifacts -> make clean

CXX = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -Wpedantic -O2 -g
SANFLAGS = -fsanitize=address,undefined
LDFLAGS =

# Source files
SERVER_SRC = server.cpp hashtable.cpp avl.cpp
CLIENT_SRC = client.cpp
TEST_AVL_SRC = test_avl.cpp avl.cpp

# Default target
all: server client test_avl

# Build server
server: $(SERVER_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@ $(LDFLAGS)

# Build client
client: $(CLIENT_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@ $(LDFLAGS)

# Build AVL tests
test_avl: $(TEST_AVL_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $@ $(LDFLAGS)

# Debug build with sanitizers
debug: CXXFLAGS += $(SANFLAGS)
debug: clean all

# Clean build artifacts
clean:
	rm -f server client test_avl *.o
